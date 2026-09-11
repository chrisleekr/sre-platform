// the incident-open runbook seeder. `makeRunbookSeeder({ db, embedder, scoreFloor, k })`
// returns `(tenantId, { title, service, severity }) => Promise<RunbookSeed[]>` that builds the query
// `[title, service, severity].filter(Boolean).join(' ')` (falling back to service+severity when the
// classifier produced no title), searches the tenant's `runbook` chunks above the score floor, and
// maps each hit to { title, content, occurrenceCount, verified } — dropping the raw cosine score and
// createdAt so the engine never treats similarity as certainty.
//
// Live-PG harness mirrors search-runbooks.test.ts / worker.test.ts: the tenant rows are inserted as
// admin, runbooks are seeded as app_user under RLS, and a deterministic recording fake Embedder makes
// ranking predictable offline and captures the embedded query text for the query-construction assertions.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  knowledgeChunks,
  upsertRunbook,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { makeRunbookSeeder } from '../runbook-seeder';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const SEED_TERMS = ['database', 'network'] as const;
const BASELINE = 0.01;

// Near one-hot on the first matched seed term (miss → its own orthogonal slot), so a query sharing a
// term with a runbook's content ranks near 1.0 and a term-less query ranks well below any floor.
function fakeVector(text: string): number[] {
  const vec = Array.from({ length: EMBED_DIM }, () => BASELINE);
  const lower = text.toLowerCase();
  const hit = SEED_TERMS.findIndex((term) => lower.includes(term));
  vec[hit === -1 ? SEED_TERMS.length : hit] = BASELINE + 1;
  return vec;
}

// Records every embedded string; searchChunks embeds exactly the built query once, so resetting the
// recorder before a seeder call leaves embedInputs[0] === the query the seeder built.
const embedInputs: string[] = [];
const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => {
    embedInputs.push(...texts);
    return Promise.resolve(texts.map(fakeVector));
  },
};

const RUNBOOK = {
  title: 'DB pool exhaustion runbook',
  content: 'Restart pgbouncer when the database connection pool is exhausted.',
};

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'RSA' },
    { id: tenantB, name: 'RSB' },
  ]);
  // One 'runbook' chunk under tenant A only (occurrence_count=1, verified=false via upsertRunbook).
  await upsertRunbook(app.db, fakeEmbedder, tenantA, {
    title: RUNBOOK.title,
    content: RUNBOOK.content,
    sourceIncidentId: randomUUID(),
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeRunbookSeeder', () => {
  test('builds the query as title + service + severity', async () => {
    const seeder = makeRunbookSeeder({ db: app.db, embedder: fakeEmbedder, scoreFloor: 0, k: 5 });
    embedInputs.length = 0;
    await seeder(tenantA, {
      title: 'database pool exhausted',
      service: 'checkout',
      severity: 'sev2',
    });
    expect(embedInputs[0]).toBe('database pool exhausted checkout sev2');
  });

  test('falls back to service + severity when the classifier produced no title', async () => {
    const seeder = makeRunbookSeeder({ db: app.db, embedder: fakeEmbedder, scoreFloor: 0, k: 5 });
    embedInputs.length = 0;
    await seeder(tenantA, { service: 'checkout', severity: 'sev2' });
    expect(embedInputs[0]).toBe('checkout sev2');
  });

  test('maps hits to { title, content, occurrenceCount, verified } — no score, no createdAt', async () => {
    const seeder = makeRunbookSeeder({
      db: app.db,
      embedder: fakeEmbedder,
      scoreFloor: 0.75,
      k: 3,
    });
    const result = await seeder(tenantA, { title: 'database', service: 'db', severity: 'sev1' });
    expect(result.length).toBeGreaterThanOrEqual(1);
    const seeded = result[0]! as unknown as Record<string, unknown>;
    expect(seeded.title).toBe(RUNBOOK.title);
    expect(seeded.content).toBe(RUNBOOK.content);
    expect(typeof seeded.occurrenceCount).toBe('number');
    expect(typeof seeded.verified).toBe('boolean');
    expect('score' in seeded).toBe(false);
    expect('createdAt' in seeded).toBe(false);
  });

  test('returns [] when nothing clears the score floor (cold-start)', async () => {
    const seeder = makeRunbookSeeder({
      db: app.db,
      embedder: fakeEmbedder,
      scoreFloor: 0.75,
      k: 3,
    });
    // A term-less query ranks well below the floor against the seeded 'database' runbook.
    const result = await seeder(tenantA, { service: 'unrelated', severity: 'sevX' });
    expect(result).toEqual([]);
  });

  test('C8 RLS isolation: tenant B never receives tenant A runbooks', async () => {
    // No floor + a matching query, so a leak WOULD surface a hit — RLS is the only thing hiding it.
    const seeder = makeRunbookSeeder({ db: app.db, embedder: fakeEmbedder, scoreFloor: 0, k: 5 });
    const result = await seeder(tenantB, { title: 'database', service: 'db', severity: 'sev1' });
    expect(result).toEqual([]);
  });
});
