// C1 + C2: the two SLO tables are tenant-scoped by the canonical policy, not by a WHERE clause, and
// the burn-event child carries the composite same-tenant FK (referential-integrity checks bypass RLS,
// so a plain slo_id FK would be a cross-tenant existence oracle). Plus the repo contract the read
// model and the CRUD router depend on: the four CHECK constraints, the one-query recent-N window, and
// the cascade that clears an objective's history with it.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  withTenant,
  tenants,
  slos,
  sloBurnEvents,
  createSlo as createSloAt,
  SloLimitReachedError,
  pruneBurnEvents,
  recordEvalOutcome,
  MAX_EVAL_ERROR_LEN,
  listSlos,
  listEnabledSlos,
  listSlosByService,
  getSlo,
  updateSlo,
  deleteSlo,
  recordBurnEvent,
  recentBurnEventsForSlos,
  type DbHandle,
  type NewSlo,
} from '../index';

// Every existing case is about isolation and constraints, not the ceiling, so they run under a cap far
// above what they create. The ceiling has its own describe block below.
const UNREACHABLE_CAP = 1_000;
const createSlo = (db: Parameters<typeof createSloAt>[0], tenantId: string, input: NewSlo) =>
  createSloAt(db, tenantId, input, UNREACHABLE_CAP);

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

/** Distinct now()-backed computed_at across sequential inserts makes ordering deterministic. */
const tick = () => new Promise((r) => setTimeout(r, 5));

const availability = (over: Partial<NewSlo> = {}): NewSlo => ({
  name: `checkout-availability-${randomUUID().slice(0, 8)}`,
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
  ...over,
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'SLO-A' },
    { id: tenantB, name: 'SLO-B' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(sloBurnEvents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(slos).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

// Every burn-event read in this file goes through the one surviving reader, which is also the only
// one production uses. It returns a map keyed by objective, so an absent key and an empty list are
// the same "no history" answer.
async function burnRatesFor(tenantId: string, sloId: string, limit = 10): Promise<number[]> {
  const byId = await recentBurnEventsForSlos(app.db, tenantId, [sloId], limit);
  return (byId.get(sloId) ?? []).map((e) => e.burnRate);
}

// SQLSTATE assertions rather than "it threw": the code proves WHICH constraint rejected the write.
// drizzle wraps driver errors so the code is on `.cause.code`; fall back to `.code` when unwrapped.
async function expectSqlState(run: Promise<unknown>, state: string): Promise<void> {
  let err: { code?: string; cause?: { code?: string } } | undefined;
  try {
    await run;
  } catch (e) {
    err = e as typeof err;
  }
  expect(err, `expected the write to be rejected with SQLSTATE ${state}`).toBeDefined();
  expect(err?.code ?? err?.cause?.code).toBe(state);
}

describe('C1: the SLO tables carry the canonical tenant-isolation policy', () => {
  for (const table of ['slos', 'slo_burn_events']) {
    test(`${table} has tenant_id, RLS enabled AND forced, and exactly one tenant_isolation policy`, async () => {
      const [security] = await admin.sql<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>
      >`
        SELECT c.relrowsecurity, c.relforcerowsecurity,
          (SELECT count(*)::int FROM pg_policies WHERE tablename = ${table}) AS policies
        FROM pg_class c WHERE c.oid = ${table}::regclass
      `;
      // FORCE is what makes the policy bind for the table owner too; without it the coverage
      // assertion in the migration bootstrap fails and RLS is decorative.
      expect(security).toEqual({ relrowsecurity: true, relforcerowsecurity: true, policies: 1 });

      const [policy] = await admin.sql<
        Array<{ policyname: string; cmd: string; permissive: string; qual: string; wc: string }>
      >`
        SELECT policyname, cmd, permissive, qual, with_check AS wc
        FROM pg_policies WHERE tablename = ${table}
      `;
      expect(policy!.policyname).toBe('tenant_isolation');
      expect(policy!.cmd).toBe('ALL');
      expect(policy!.permissive).toBe('PERMISSIVE');
      // The one clause, on both the read and the write side. nullif maps an unset app.tenant_id to
      // NULL so "no tenant context" means no rows rather than a match on the empty string.
      for (const clause of [policy!.qual, policy!.wc]) {
        expect(clause).toContain("current_setting('app.tenant_id'::text, true)");
        expect(clause).toContain('NULLIF');
        expect(clause).toContain('tenant_id');
      }

      const [column] = await admin.sql<Array<{ is_nullable: string; data_type: string }>>`
        SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = ${table} AND column_name = 'tenant_id'
      `;
      expect(column).toEqual({ is_nullable: 'NO', data_type: 'uuid' });
    });
  }
});

describe('C2: a tenant reads only its own objectives and burn events', () => {
  test('objectives written by A are invisible to B by list, by id, and by service', async () => {
    const name = `iso-${randomUUID().slice(0, 8)}`;
    const service = `iso-svc-${randomUUID().slice(0, 8)}`;
    const a = await createSlo(app.db, tenantA, availability({ name, service }));

    expect((await listSlos(app.db, tenantA)).map((s) => s.id)).toContain(a.id);
    expect((await listSlos(app.db, tenantB)).map((s) => s.id)).not.toContain(a.id);
    expect(await getSlo(app.db, tenantB, a.id)).toBeUndefined();
    expect(await listSlosByService(app.db, tenantB, service)).toEqual([]);
    // The unique name is per tenant, so B may use the same one without colliding.
    const b = await createSlo(app.db, tenantB, availability({ name, service }));
    expect(b.tenantId).toBe(tenantB);
  });

  test('burn events written by A are invisible to B', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    await recordBurnEvent(app.db, tenantA, {
      sloId: a.id,
      budgetPct: 0.4,
      burnRate: 3,
      window: '1h',
    });

    expect(await burnRatesFor(tenantA, a.id)).toEqual([3]);
    // B asking for A's objective by id gets nothing back, not a shorter list: the policy, not a
    // filter in the query, is what removes the rows.
    expect(await burnRatesFor(tenantB, a.id)).toEqual([]);
    expect((await recentBurnEventsForSlos(app.db, tenantB, [a.id], 5)).size).toBe(0);
  });

  test('B cannot attach a burn event to A objective (composite same-tenant FK, not a plain FK)', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    // 23503 = foreign_key_violation: the composite (tenant_id, slo_id) key refuses the cross-tenant
    // reference. A plain slo_id FK would ACCEPT this and leak A objective's existence to B.
    await expectSqlState(
      withTenant(app.db, tenantB, (tx) =>
        tx
          .insert(sloBurnEvents)
          .values({ tenantId: tenantB, sloId: a.id, budgetPct: 1, burnRate: 0, window: '1h' }),
      ),
      '23503',
    );
  });

  test('deleting an objective cascades its burn events away', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    await recordBurnEvent(app.db, tenantA, {
      sloId: a.id,
      budgetPct: 0.9,
      burnRate: 0.5,
      window: '1h',
    });
    expect(await burnRatesFor(tenantA, a.id)).toHaveLength(1);

    await deleteSlo(app.db, tenantA, a.id);

    expect(await getSlo(app.db, tenantA, a.id)).toBeUndefined();
    expect(await burnRatesFor(tenantA, a.id)).toEqual([]);
  });
});

describe('a workspace purge takes the objectives and their history with it', () => {
  test('deleting the tenant row cascades both SLO tables away', async () => {
    // The workspace-purge path deletes the `tenants` row. Both tenant_id columns must therefore be
    // ON DELETE CASCADE, like every sibling table: without it the first objective a tenant defines
    // makes that delete fail with 23503 (foreign_key_violation) and strands the two tables. This
    // reads back through the app connection, so it proves the rows are gone rather than merely
    // invisible to a privileged role.
    const doomed = randomUUID();
    await admin.db.insert(tenants).values({ id: doomed, name: `SLO-purge-${doomed.slice(0, 8)}` });
    const objective = await createSlo(app.db, doomed, availability());
    await recordBurnEvent(app.db, doomed, {
      sloId: objective.id,
      budgetPct: 0.9,
      burnRate: 0.5,
      window: '1h',
    });
    expect(await listSlos(app.db, doomed)).toHaveLength(1);
    expect(await burnRatesFor(doomed, objective.id)).toHaveLength(1);

    await admin.db.delete(tenants).where(sql`id = ${doomed}`);

    expect(await listSlos(app.db, doomed)).toEqual([]);
    expect(await burnRatesFor(doomed, objective.id)).toEqual([]);
  });
});

describe('the CHECK constraints guard every writer, not just the router', () => {
  test('an unknown sli_type is rejected', async () => {
    // 23514 = check_violation.
    await expectSqlState(
      createSlo(app.db, tenantA, availability({ sliType: 'throughput' as NewSlo['sliType'] })),
      '23514',
    );
  });

  test('a target outside (0,1) is rejected, so the error budget is never zero or negative', async () => {
    await expectSqlState(createSlo(app.db, tenantA, availability({ target: 1 })), '23514');
    await expectSqlState(createSlo(app.db, tenantA, availability({ target: 0 })), '23514');
    await expectSqlState(createSlo(app.db, tenantA, availability({ target: 1.5 })), '23514');
  });

  test('a non-positive window is rejected', async () => {
    await expectSqlState(createSlo(app.db, tenantA, availability({ windowDays: 0 })), '23514');
  });

  test('a latency objective needs a threshold and an availability objective must not carry one', async () => {
    await expectSqlState(
      createSlo(app.db, tenantA, availability({ sliType: 'latency', thresholdMs: null })),
      '23514',
    );
    await expectSqlState(createSlo(app.db, tenantA, availability({ thresholdMs: 250 })), '23514');
    const ok = await createSlo(
      app.db,
      tenantA,
      availability({ sliType: 'latency', thresholdMs: 250 }),
    );
    expect(ok.thresholdMs).toBe(250);
  });

  test('a duplicate name within one tenant is rejected', async () => {
    const name = `dup-${randomUUID().slice(0, 8)}`;
    await createSlo(app.db, tenantA, availability({ name }));
    // 23505 = unique_violation.
    await expectSqlState(createSlo(app.db, tenantA, availability({ name })), '23505');
  });
});

describe('objective CRUD', () => {
  test('list, enabled-only and by-service reads are name-ordered and correctly filtered', async () => {
    const service = `crud-${randomUUID().slice(0, 8)}`;
    const on = await createSlo(
      app.db,
      tenantA,
      availability({ name: `aaa-${randomUUID().slice(0, 8)}`, service }),
    );
    const off = await createSlo(
      app.db,
      tenantA,
      availability({ name: `zzz-${randomUUID().slice(0, 8)}`, service, enabled: false }),
    );

    const all = (await listSlos(app.db, tenantA)).filter((s) => s.service === service);
    expect(all.map((s) => s.id)).toEqual([on.id, off.id]);
    const enabled = (await listEnabledSlos(app.db, tenantA)).filter((s) => s.service === service);
    expect(enabled.map((s) => s.id)).toEqual([on.id]);
    // Disabled objectives are excluded from the service read: the evaluator stops refreshing them,
    // so their last-known budget is stale and would mislead triage.
    expect((await listSlosByService(app.db, tenantA, service)).map((s) => s.id)).toEqual([on.id]);
  });

  test('a partial patch changes only the named fields and bumps updated_at', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    await tick();

    const patched = await updateSlo(app.db, tenantA, a.id, { target: 0.99, enabled: false });

    expect(patched!.target).toBeCloseTo(0.99, 9);
    expect(patched!.enabled).toBe(false);
    expect(patched!.service).toBe(a.service);
    expect(patched!.metricQuery).toBe(a.metricQuery);
    expect(patched!.updatedAt.getTime()).toBeGreaterThan(a.updatedAt.getTime());
  });

  test('patching or deleting another tenant objective is a miss, not a write', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    expect(await updateSlo(app.db, tenantB, a.id, { enabled: false })).toBeUndefined();
    await deleteSlo(app.db, tenantB, a.id);
    expect((await getSlo(app.db, tenantA, a.id))!.enabled).toBe(true);
  });
});

describe('recentBurnEventsForSlos', () => {
  test('returns the recent N per objective in one query, newest-first, keyed by objective', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    const b = await createSlo(app.db, tenantA, availability());
    for (const rate of [1, 2, 3]) {
      await recordBurnEvent(app.db, tenantA, {
        sloId: a.id,
        budgetPct: 0.5,
        burnRate: rate,
        window: '1h',
      });
      await tick();
    }
    await recordBurnEvent(app.db, tenantA, {
      sloId: b.id,
      budgetPct: 0.7,
      burnRate: 9,
      window: '1h',
    });

    const byId = await recentBurnEventsForSlos(app.db, tenantA, [a.id, b.id], 2);

    expect([...byId.keys()].sort()).toEqual([a.id, b.id].sort());
    // Newest-first, and the window caps EACH partition at 2 rather than the result set at 2.
    expect(byId.get(a.id)!.map((e) => e.burnRate)).toEqual([3, 2]);
    expect(byId.get(b.id)!.map((e) => e.burnRate)).toEqual([9]);
  });

  test('an empty id list short-circuits to an empty map', async () => {
    expect(await recentBurnEventsForSlos(app.db, tenantA, [], 5)).toEqual(new Map());
  });

  test('an event older than the read window is not scanned, so the read cost is bounded by time', async () => {
    const a = await createSlo(app.db, tenantA, availability());
    // Written through the privileged connection because the repo always stamps computed_at with
    // now(); backdating is the only way to stand on the far side of the window.
    await admin.sql`
      INSERT INTO slo_burn_events (tenant_id, slo_id, budget_pct, burn_rate, "window", computed_at)
      VALUES (${tenantA}::uuid, ${a.id}::uuid, 0.1, 42, '1h', now() - interval '400 days')
    `;
    expect(await burnRatesFor(tenantA, a.id)).toEqual([]);

    await recordBurnEvent(app.db, tenantA, {
      sloId: a.id,
      budgetPct: 0.5,
      burnRate: 4,
      window: '1h',
    });
    // The recent event is still returned; only the ancient one is out of scan range.
    expect(await burnRatesFor(tenantA, a.id)).toEqual([4]);
  });
});

// The per-tenant ceiling. It was enforced in the router by counting and then inserting, which two
// concurrent creates can both win. It now lives inside the insert transaction behind a per-tenant
// advisory lock, so the race is closed at the only layer that can close it.
describe('the per-tenant objective ceiling is enforced inside the write', () => {
  test('a create past the ceiling is refused and writes nothing', async () => {
    const tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'CAP-SEQ' });
    const cap = 3;
    for (let i = 0; i < cap; i++) {
      await createSloAt(app.db, tenantId, availability({ name: `seq-${i}` }), cap);
    }
    await expect(
      createSloAt(app.db, tenantId, availability({ name: 'one-too-many' }), cap),
    ).rejects.toBeInstanceOf(SloLimitReachedError);
    expect(await listSlos(app.db, tenantId)).toHaveLength(cap);
  });

  test('a create holds a per-tenant lock across its count and its insert', async () => {
    // THE POINT OF THE CHANGE, and it has to be proven deterministically. Simply firing two creates at
    // once does not reproduce the old bug: the two round trips usually do not interleave, so that test
    // passes with or without the fix and pins nothing. Instead hold the exact lock the writer takes
    // and observe that the writer waits. Remove the lock from `createSlo` and this goes red, because
    // the create then counts and inserts straight through while another writer sits between the two.
    const tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'CAP-LOCK' });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });

    const blocker = app.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`slo-create:${tenantId}`}, 0))`,
      );
      taken();
      await held;
    });
    await lockTaken;

    let settled = false;
    const pending = createSloAt(app.db, tenantId, availability({ name: 'waits' }), 5).then(
      (row) => {
        settled = true;
        return row;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(settled).toBe(false);

    release();
    await blocker;
    await pending;
    expect(settled).toBe(true);
    expect(await listSlos(app.db, tenantId)).toHaveLength(1);
  });

  test('the ceiling is per tenant, so one tenant filling it does not block another', async () => {
    const full = randomUUID();
    const other = randomUUID();
    await admin.db.insert(tenants).values([
      { id: full, name: 'CAP-FULL' },
      { id: other, name: 'CAP-OTHER' },
    ]);
    await createSloAt(app.db, full, availability({ name: 'only' }), 1);
    await expect(createSloAt(app.db, full, availability({ name: 'no' }), 1)).rejects.toBeInstanceOf(
      SloLimitReachedError,
    );
    const theirs = await createSloAt(app.db, other, availability({ name: 'only' }), 1);
    expect(theirs.tenantId).toBe(other);
  });
});

// Nothing removed burn events, so the table grew with a tenant's age forever. The sweep deletes past
// the same bound the read already stops at, so it can never remove a row a caller could have read.
describe('burn-event retention', () => {
  const backdate = async (tenantId: string, sloId: string, age: string) => {
    await admin.sql`
      INSERT INTO slo_burn_events (tenant_id, slo_id, budget_pct, burn_rate, "window", computed_at)
      VALUES (${tenantId}::uuid, ${sloId}::uuid, 0.1, 1, '1h', now() - ${age}::interval)
    `;
  };
  const countEvents = async (tenantId: string) => {
    const rows = await admin.sql`
      SELECT count(*)::int AS n FROM slo_burn_events WHERE tenant_id = ${tenantId}::uuid
    `;
    return (rows[0] as { n: number }).n;
  };

  test('removes only events past the bound, and reports how many it removed', async () => {
    const tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'PRUNE' });
    const slo = await createSlo(app.db, tenantId, availability());
    await backdate(tenantId, slo.id, '400 days');
    await backdate(tenantId, slo.id, '100 days');
    await backdate(tenantId, slo.id, '10 days');

    expect(await pruneBurnEvents(app.db, tenantId, 90, 1000)).toBe(2);
    expect(await countEvents(tenantId)).toBe(1);
    // Idempotent: a second sweep finds nothing left past the bound.
    expect(await pruneBurnEvents(app.db, tenantId, 90, 1000)).toBe(0);
  });

  test('the batch cap bounds one call and the sweep drains over repeated calls', async () => {
    const tenantId = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantId, name: 'PRUNE-BATCH' });
    const slo = await createSlo(app.db, tenantId, availability());
    for (let i = 0; i < 5; i++) await backdate(tenantId, slo.id, `${100 + i} days`);

    expect(await pruneBurnEvents(app.db, tenantId, 90, 2)).toBe(2);
    expect(await countEvents(tenantId)).toBe(3);
    expect(await pruneBurnEvents(app.db, tenantId, 90, 2)).toBe(2);
    expect(await pruneBurnEvents(app.db, tenantId, 90, 2)).toBe(1);
    expect(await countEvents(tenantId)).toBe(0);
  });

  test('a sweep touches only the calling tenant', async () => {
    const mine = randomUUID();
    const theirs = randomUUID();
    await admin.db.insert(tenants).values([
      { id: mine, name: 'PRUNE-MINE' },
      { id: theirs, name: 'PRUNE-THEIRS' },
    ]);
    const a = await createSlo(app.db, mine, availability());
    const b = await createSlo(app.db, theirs, availability());
    await backdate(mine, a.id, '400 days');
    await backdate(theirs, b.id, '400 days');

    expect(await pruneBurnEvents(app.db, mine, 90, 1000)).toBe(1);
    // RLS scopes the delete: the other tenant's equally ancient event is untouched.
    expect(await countEvents(theirs)).toBe(1);
  });
});

// A failed evaluation writes no burn event, so without this the objective is indistinguishable from
// one that has never run and the operator's only signal is a worker log line they cannot reach.
describe('the last evaluation outcome is recorded on the objective', () => {
  test('a failure is stored and a later success clears it', async () => {
    const slo = await createSlo(app.db, tenantA, availability());
    expect(slo.lastEvalError).toBeNull();
    expect(slo.evalFailingSince).toBeNull();

    expect(
      await recordEvalOutcome(app.db, tenantA, slo.id, 'query did not resolve to a numeric ratio'),
    ).toBe(true);
    const failed = await getSlo(app.db, tenantA, slo.id);
    expect(failed?.lastEvalError).toBe('query did not resolve to a numeric ratio');
    expect(failed?.evalFailingSince).toBeInstanceOf(Date);

    // A transient outage must not mark the objective broken forever.
    expect(await recordEvalOutcome(app.db, tenantA, slo.id, null)).toBe(true);
    const recovered = await getSlo(app.db, tenantA, slo.id);
    expect(recovered?.lastEvalError).toBeNull();
    // The two columns always agree: no failure means no start time.
    expect(recovered?.evalFailingSince).toBeNull();
  });

  test('an overlong message is truncated rather than stored whole', async () => {
    const slo = await createSlo(
      app.db,
      tenantA,
      availability({ name: `long-${randomUUID().slice(0, 8)}` }),
    );
    await recordEvalOutcome(app.db, tenantA, slo.id, 'x'.repeat(MAX_EVAL_ERROR_LEN + 250));
    const stored = await getSlo(app.db, tenantA, slo.id);
    expect(stored?.lastEvalError).toHaveLength(MAX_EVAL_ERROR_LEN);
  });

  test('an unchanged outcome writes nothing, so a definition table stays cold', async () => {
    // THE REASON THE PREDICATE EXISTS. Evaluation runs every five minutes forever. Writing the same
    // outcome each time would rewrite a small definition table hundreds of times a day to store what
    // it already said, and would reset the failure start time on every pass.
    const slo = await createSlo(
      app.db,
      tenantA,
      availability({ name: `cold-${randomUUID().slice(0, 8)}` }),
    );
    expect(await recordEvalOutcome(app.db, tenantA, slo.id, 'backend unreachable')).toBe(true);
    const first = await getSlo(app.db, tenantA, slo.id);

    expect(await recordEvalOutcome(app.db, tenantA, slo.id, 'backend unreachable')).toBe(false);
    const second = await getSlo(app.db, tenantA, slo.id);
    // Unchanged row, so the failure still reads as having started when it actually started.
    expect(second?.evalFailingSince?.getTime()).toBe(first?.evalFailingSince?.getTime());

    // A healthy objective that was already healthy writes nothing either.
    expect(await recordEvalOutcome(app.db, tenantA, slo.id, null)).toBe(true);
    expect(await recordEvalOutcome(app.db, tenantA, slo.id, null)).toBe(false);
  });

  test('a different failure is a change, so the start time follows the current failure', async () => {
    const slo = await createSlo(
      app.db,
      tenantA,
      availability({ name: `change-${randomUUID().slice(0, 8)}` }),
    );
    await recordEvalOutcome(app.db, tenantA, slo.id, 'first failure');
    expect(await recordEvalOutcome(app.db, tenantA, slo.id, 'second failure')).toBe(true);
    const row = await getSlo(app.db, tenantA, slo.id);
    expect(row?.lastEvalError).toBe('second failure');
    expect(row?.evalFailingSince).toBeInstanceOf(Date);
  });

  test('one tenant cannot record an outcome on another tenant objective', async () => {
    const mine = await createSlo(
      app.db,
      tenantA,
      availability({ name: `x-${randomUUID().slice(0, 8)}` }),
    );
    await recordEvalOutcome(app.db, tenantB, mine.id, 'not yours');
    expect((await getSlo(app.db, tenantA, mine.id))?.lastEvalError).toBeNull();
  });
});
