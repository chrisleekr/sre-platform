// live-Postgres pgvector retrieval for the incident correlation shortlist. Mirrors
// knowledge-repo.test.ts: admin (superuser) seeds/cleans the control-plane tenants; the repo runs as
// app_user so FORCE ROW LEVEL SECURITY binds. A deterministic fake Embedder maps each text to a
// near-one-hot EMBED_DIM vector keyed by the first seed term it contains, so a query and an incident
// that share a term get cosine distance ~0 — ranking is predictable offline. retrieveNearestActive
// returns the top-K nearest ACTIVE incidents with a non-null embedding, tenant-scoped, no score floor.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  incidents,
  incidentMessages,
  createIncident,
  transitionIncidentTx,
  withTenant,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '../index';
// Phase-B additions — namespace access so a not-yet-exported symbol reads as `undefined`
// (per-assertion RED) rather than an ESM link error.
import * as incidentRepo from '../incident-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const SEED_TERMS = ['database', 'network', 'disk'] as const;
const BASELINE = 0.01;

function fakeVector(text: string): number[] {
  const vec = Array.from({ length: EMBED_DIM }, () => BASELINE);
  const lower = text.toLowerCase();
  const hit = SEED_TERMS.findIndex((term) => lower.includes(term));
  vec[hit === -1 ? SEED_TERMS.length : hit] = BASELINE + 1;
  return vec;
}

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(fakeVector)),
};

const DB_TEXT = 'the database connection pool is exhausted';
const NET_TEXT = 'a network partition across availability zones causes timeouts';
const DISK_TEXT = 'disk pressure fills the data volume; prune old logs';
const DB_QUERY = 'the database connection pool keeps getting exhausted';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
// ids captured during seeding, keyed by role.
const ids: Record<string, string> = {};

async function seedIncident(
  tenant: string,
  service: string,
  seedText: string | null,
  status: 'open' | 'resolved',
): Promise<string> {
  const { id } = await createIncident(app.db, tenant, {
    fingerprint: `fp-${randomUUID()}`,
    alertSource: 'slack',
    service,
    severity: 'sev2',
  });
  if (seedText !== null) {
    const [vec] = await fakeEmbedder.embed([seedText]);
    await incidentRepo.setIncidentEmbedding(app.db, tenant, id, vec!);
  }
  if (status === 'resolved') {
    await withTenant(app.db, tenant, (tx) => transitionIncidentTx(tx, id, 'resolved'));
  }
  return id;
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  // tenant A: three active incidents with distinct embeddings, one resolved-with-embedding
  // (excluded by status), one active-with-null-embedding (excluded by embedding-not-null).
  ids.dbA = await seedIncident(tenantA, 'db-svc', DB_TEXT, 'open');
  ids.netA = await seedIncident(tenantA, 'net-svc', NET_TEXT, 'open');
  ids.diskA = await seedIncident(tenantA, 'disk-svc', DISK_TEXT, 'open');
  ids.resolvedA = await seedIncident(tenantA, 'db-resolved', DB_TEXT, 'resolved');
  ids.nullA = await seedIncident(tenantA, 'db-noembed', null, 'open');
  // tenant B: one active db incident — must never surface for tenant A (RLS).
  ids.dbB = await seedIncident(tenantB, 'db-svc-b', DB_TEXT, 'open');
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('retrieveNearestActive (pgvector shortlist + RLS)', () => {
  const since = () => new Date(Date.now() - 24 * 60 * 60 * 1000); // now - 24h

  it('C7 returns the top-K nearest active incidents by cosine, nearest first, no score floor', async () => {
    const results = await incidentRepo.retrieveNearestActive(app.db, fakeEmbedder, tenantA, {
      text: DB_QUERY,
      k: 2,
      since: since(),
    });
    expect(results).toHaveLength(2); // limited to k
    // The db incident shares the query's seed term → ranks first.
    expect(results[0]!.id).toBe(ids.dbA);
    // No score floor: the 2nd result is a weakly-matching active incident, still returned.
    expect(results.map((r) => r.id)).not.toContain(ids.resolvedA);
    expect(results.map((r) => r.id)).not.toContain(ids.nullA);
  });

  it('C7 excludes resolved incidents and incidents with a null embedding', async () => {
    const results = await incidentRepo.retrieveNearestActive(app.db, fakeEmbedder, tenantA, {
      text: DB_QUERY,
      k: 10,
      since: since(),
    });
    const rIds = results.map((r) => r.id);
    expect(rIds).toContain(ids.dbA);
    expect(rIds).toContain(ids.netA);
    expect(rIds).toContain(ids.diskA);
    expect(rIds).not.toContain(ids.resolvedA); // resolved: excluded by status
    expect(rIds).not.toContain(ids.nullA); // no embedding: excluded
  });

  it('C8 is tenant-scoped: tenant A never retrieves tenant B’s incident, and vice versa (RLS)', async () => {
    const asA = await incidentRepo.retrieveNearestActive(app.db, fakeEmbedder, tenantA, {
      text: DB_QUERY,
      k: 10,
      since: since(),
    });
    expect(asA.map((r) => r.id)).not.toContain(ids.dbB);

    const asB = await incidentRepo.retrieveNearestActive(app.db, fakeEmbedder, tenantB, {
      text: DB_QUERY,
      k: 10,
      since: since(),
    });
    expect(asB.map((r) => r.id)).toEqual([ids.dbB]); // B sees only its own
    expect(asB.map((r) => r.id)).not.toContain(ids.dbA);
  });

  it('C5 surfaces the title on the retrieved summary', async () => {
    const { id: titledId } = await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'titled-svc',
      severity: 'sev2',
      title: 'DB pool exhaustion',
    } as Parameters<typeof createIncident>[2]);
    const [vec] = await fakeEmbedder.embed([DB_TEXT]);
    await incidentRepo.setIncidentEmbedding(app.db, tenantA, titledId, vec!);

    const results = await incidentRepo.retrieveNearestActive(app.db, fakeEmbedder, tenantA, {
      text: DB_QUERY,
      k: 10,
      since: since(),
    });
    const titled = results.find((r) => r.id === titledId) as { title?: string } | undefined;
    expect(titled).toBeDefined();
    expect(titled!.title).toBe('DB pool exhaustion');
  });
});
