// Phase A (RED): tests for the reworked ConversationHub.history() total order + bounded/keyset
// reads and the new opener(). The production signature below does not exist yet, so these
// fail to compile / at runtime until Phase B lands. Deterministic ordering is proven by seeding
// rows with EXPLICIT (created_at, id) via the admin conn, then reading through the RLS app conn.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  incidents,
  incidentMessages,
  createIncident,
  type DbHandle,
} from '@sre/db';
import { ConversationHub } from '../hub';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let hub: ConversationHub;
let tenantA: string;
let tenantB: string;
let mainIncident: string; // tenantA, 5 messages, strictly increasing created_at
let tieIncident: string; // tenantA, 3 messages, two share an identical created_at
let emptyIncident: string; // tenantA, no messages

// Deterministic uuid so (created_at, id) ordering is reproducible and byte-comparable.
function uuidN(n: number): string {
  return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

// Insert a message with an EXPLICIT id + created_at through the admin (RLS-bypassing) conn.
async function seed(
  incidentId: string,
  id: string,
  content: string,
  createdAt: Date,
): Promise<void> {
  await admin.db.insert(incidentMessages).values({
    id,
    tenantId: tenantA,
    incidentId,
    author: 'agent',
    content,
    createdAt,
  });
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  hub = new ConversationHub(app.db, redis);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);

  const mk = async (svc: string) =>
    (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: svc,
        severity: 'sev2',
      })
    ).id;
  mainIncident = await mk('main');
  tieIncident = await mk('tie');
  emptyIncident = await mk('empty');

  // main: five strictly-increasing timestamps, ids ascending in the same order.
  for (let k = 1; k <= 5; k++) {
    await seed(mainIncident, uuidN(10 + k), `m${k}`, new Date(`2026-01-02T00:00:0${k}.000Z`));
  }

  // tie: A at t0; B and C SHARE t1 (id2 < id3). Insert in reverse (C, B, A) so heap/insertion order
  // differs from the expected (created_at, id) order — a missing id tiebreak yields C before B.
  const t0 = new Date('2026-01-01T00:00:00.000Z');
  const t1 = new Date('2026-01-01T00:00:01.000Z');
  await seed(tieIncident, uuidN(3), 'C', t1);
  await seed(tieIncident, uuidN(2), 'B', t1);
  await seed(tieIncident, uuidN(1), 'A', t0);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
  redis.disconnect();
});

describe('ConversationHub.history total order + bounded/keyset reads', () => {
  test('ordering: tied created_at rows come back in deterministic ascending (created_at, id) order', async () => {
    // Loop to catch a nondeterministic tie-break: the id sequence must be [A, B, C] every time.
    for (let i = 0; i < 5; i++) {
      const hist = await hub.history(tenantA, tieIncident);
      expect(hist.map((h) => h.id)).toEqual([uuidN(1), uuidN(2), uuidN(3)]);
      expect(hist.map((h) => h.content)).toEqual(['A', 'B', 'C']);
    }
  });

  test('unbounded default: returns all N messages ascending', async () => {
    const hist = await hub.history(tenantA, mainIncident);
    expect(hist.map((h) => h.content)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
  });

  test('limit returns the newest N, still ascending', async () => {
    const hist = await hub.history(tenantA, mainIncident, { limit: 2 });
    expect(hist.map((h) => h.content)).toEqual(['m4', 'm5']);
  });

  test('before keyset returns only strictly-older messages ascending', async () => {
    const all = await hub.history(tenantA, mainIncident);
    const fourth = all[3]!; // m4
    const older = await hub.history(tenantA, mainIncident, {
      before: { createdAt: fourth.createdAt, id: fourth.id },
    });
    expect(older.map((h) => h.content)).toEqual(['m1', 'm2', 'm3']);
  });

  test('before keyset with a tied created_at cursor returns the same-timestamp older sibling', async () => {
    // cursor = C (t1, uuidN(3)); B shares t1 but has a smaller id, so it is strictly older
    const older = await hub.history(tenantA, tieIncident, {
      before: { createdAt: new Date('2026-01-01T00:00:01.000Z').toISOString(), id: uuidN(3) },
    });
    expect(older.map((h) => h.content)).toEqual(['A', 'B']); // not ['A'] (skip) nor ['A','B','C'] (cursor leak)
  });

  test('limit + before returns the newest N strictly older than the cursor, ascending', async () => {
    const all = await hub.history(tenantA, mainIncident);
    const fifth = all[4]!; // m5
    const page = await hub.history(tenantA, mainIncident, {
      limit: 2,
      before: { createdAt: fifth.createdAt, id: fifth.id },
    });
    expect(page.map((h) => h.content)).toEqual(['m3', 'm4']);
  });

  test('opener returns the earliest message', async () => {
    const first = await hub.opener(tenantA, mainIncident);
    expect(first?.content).toBe('m1');
    expect(first?.id).toBe(uuidN(11));
  });

  test('opener returns null for an incident with no messages', async () => {
    expect(await hub.opener(tenantA, emptyIncident)).toBeNull();
  });

  test('tenant isolation: another tenant sees no history and no opener', async () => {
    expect(await hub.history(tenantB, mainIncident, { limit: 2 })).toHaveLength(0);
    expect(await hub.opener(tenantB, mainIncident)).toBeNull();
  });
});
