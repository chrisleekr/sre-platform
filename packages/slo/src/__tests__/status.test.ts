// The read model behind the triage brief, the always-bound tool, and the dashboard panel. Live
// Postgres under RLS: the SLO definitions and burn events are written as app_user through the repo,
// so tenant scoping here is the real policy, not a WHERE clause in the query. Nothing in this file
// writes an SLI sample, because the platform stores none. RED until `packages/slo` exists.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  createSlo as createSloAt,
  recordBurnEvent,
  recordEvalOutcome,
  tenants,
  slos,
  type Db,
  type DbHandle,
} from '@sre/db';
import { sloStatusForService, renderSloBrief, sloDashboard, type SloStatusView } from '../status';

// These cases are about the read model, not the per-tenant ceiling, so they run under a cap they
// never reach. The ceiling has its own coverage in the repository suite.
const UNREACHABLE_CAP = 1_000;
const createSlo = (db: Db, tid: string, input: Parameters<typeof createSloAt>[2]) =>
  createSloAt(db, tid, input, UNREACHABLE_CAP);

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let otherTenantId: string;

// Distinct now()-backed computedAt across sequential inserts; a small gap makes ordering deterministic.
const tick = () => new Promise((r) => setTimeout(r, 5));

const newSlo = (service: string, name: string, enabled = true) => ({
  name,
  service,
  sliType: 'availability' as const,
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
  enabled,
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  otherTenantId = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantId, name: 'SLO-STATUS' },
    { id: otherTenantId, name: 'SLO-STATUS-OTHER' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    // Burn events cascade off their SLO through the composite same-tenant FK.
    await admin.db.delete(slos).where(sql`tenant_id in (${tenantId}, ${otherTenantId})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantId}, ${otherTenantId})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('sloStatusForService', () => {
  test('carries budget, burn and the on-read exhaustion projection once a burn event exists', async () => {
    const service = `checkout-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `avail-${randomUUID().slice(0, 8)}`),
    );
    await recordBurnEvent(app.db, tenantId, {
      sloId: slo.id,
      budgetPct: 0.5,
      burnRate: 2,
      window: '1h',
    });

    const views = await sloStatusForService(app.db, tenantId, service);

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({
      name: slo.name,
      service,
      sliType: 'availability',
      target: 0.999,
      windowDays: 30,
    });
    expect(views[0]!.evaluation).not.toBe(null);
    expect(views[0]!.evaluation!.budgetRemaining).toBeCloseTo(0.5, 9);
    expect(views[0]!.evaluation!.burnRate).toBeCloseTo(2, 9);
    expect(views[0]!.evaluation!.burnWindow).toBe('1h');
    // Projected at read time from the persisted budget and rate: 0.5 * 30 / 2.
    expect(views[0]!.evaluation!.exhaustionDays).toBeCloseTo(7.5, 6);
  });

  test('carries the evaluation timestamp, so a surface can tell a stale budget from a current one', async () => {
    const service = `aged-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `aged-${randomUUID().slice(0, 8)}`),
    );
    const event = await recordBurnEvent(app.db, tenantId, {
      sloId: slo.id,
      budgetPct: 0.5,
      burnRate: 2,
      window: '1h',
    });

    const views = await sloStatusForService(app.db, tenantId, service);

    // The persisted computed_at, not the read time: without it a three-week-old projection is
    // indistinguishable from a five-minute-old one and a stopped evaluator reads as healthy.
    expect(views[0]!.evaluation!.computedAt).toBe(event.computedAt.toISOString());
  });

  test('reports a null evaluation rather than fabricating numbers before the first burn event', async () => {
    const service = `pending-${randomUUID().slice(0, 8)}`;
    await createSlo(app.db, tenantId, newSlo(service, `pend-${randomUUID().slice(0, 8)}`));

    const views = await sloStatusForService(app.db, tenantId, service);
    expect(views).toHaveLength(1);
    expect(views[0]!.evaluation).toBe(null);
  });

  test('excludes disabled objectives and other services', async () => {
    const service = `scoped-${randomUUID().slice(0, 8)}`;
    const enabledName = `on-${randomUUID().slice(0, 8)}`;
    await createSlo(app.db, tenantId, newSlo(service, enabledName, true));
    await createSlo(app.db, tenantId, newSlo(service, `off-${randomUUID().slice(0, 8)}`, false));
    await createSlo(
      app.db,
      tenantId,
      newSlo(`${service}-other`, `oth-${randomUUID().slice(0, 8)}`),
    );

    const views = await sloStatusForService(app.db, tenantId, service);
    expect(views.map((v) => v.name)).toEqual([enabledName]);
  });

  test('C2: another tenant reading the same service sees none of these objectives', async () => {
    const service = `iso-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `iso-${randomUUID().slice(0, 8)}`),
    );
    await recordBurnEvent(app.db, tenantId, {
      sloId: slo.id,
      budgetPct: 0.2,
      burnRate: 5,
      window: '1h',
    });

    expect(await sloStatusForService(app.db, otherTenantId, service)).toEqual([]);
  });

  test('a read failure propagates, so a caller that must not degrade has to catch it itself', async () => {
    // The opener brief wraps this call in its own try/catch precisely because the read model does
    // not swallow failures: it is a read model, not a best-effort side effect.
    const broken = {} as unknown as Db;
    await expect(sloStatusForService(broken, tenantId, 'checkout')).rejects.toThrow();
  });
});

const view = (over: Partial<SloStatusView> = {}): SloStatusView => ({
  name: 'checkout',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  lastEvaluationError: null,
  evaluationFailingSince: null,
  evaluation: {
    budgetRemaining: 0.5,
    burnRate: 2,
    burnWindow: '1h',
    exhaustionDays: 7.5,
    computedAt: '2026-01-01T00:00:00.000Z',
  },
  ...over,
});

describe('renderSloBrief', () => {
  test('renders one bulleted status line per evaluated objective, carrying when it was measured', () => {
    // The brief is a durable message read long after it is written, and a stopped evaluator keeps
    // serving its last result, so a figure with no measurement time reads as current when it is not.
    expect(renderSloBrief([view()])).toBe(
      'SLO status:\n- SLO "checkout" (checkout, availability 99.9% over 30d): 50.0% budget remaining; burn 2.0x over 1h; budget exhausts in ~7.5 days. Measured 2026-01-01T00:00:00.000Z.',
    );
  });

  test('an unevaluated objective is named as awaiting evaluation, never given a number', () => {
    expect(renderSloBrief([view({ evaluation: null })])).toBe(
      'SLO status:\n- SLO "checkout" (checkout, availability 99.9% over 30d): awaiting first evaluation.',
    );
  });

  test('C5: a service with no objectives renders nothing, so the opener brief is unchanged', () => {
    // The opener joins its sections with `.filter(Boolean)`. An empty string here is what makes the
    // brief byte-identical to today's for every tenant that has defined no objectives.
    expect(renderSloBrief([])).toBe('');
  });
});

describe('sloDashboard', () => {
  test('returns enabled and disabled objectives, each with its latest evaluation', async () => {
    const service = `dash-${randomUUID().slice(0, 8)}`;
    const on = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `on-${randomUUID().slice(0, 8)}`, true),
    );
    const off = await createSlo(
      app.db,
      tenantId,
      newSlo(service, `off-${randomUUID().slice(0, 8)}`, false),
    );
    await recordBurnEvent(app.db, tenantId, {
      sloId: on.id,
      budgetPct: 0.8,
      burnRate: 1,
      window: '1h',
    });
    await tick();
    await recordBurnEvent(app.db, tenantId, {
      sloId: on.id,
      budgetPct: 0.5,
      burnRate: 3,
      window: '1h',
    });

    const rows = (await sloDashboard(app.db, tenantId)).filter((r) => r.service === service);
    expect(rows).toHaveLength(2);

    const onRow = rows.find((r) => r.id === on.id)!;
    expect(onRow.enabled).toBe(true);
    expect(onRow.evaluation!.budgetRemaining).toBeCloseTo(0.5, 9);
    expect(onRow.evaluation!.burnRate).toBeCloseTo(3, 9);

    const offRow = rows.find((r) => r.id === off.id)!;
    expect(offRow.enabled).toBe(false);
    expect(offRow.evaluation).toBe(null);
  });

  test('C2: another tenant sees none of these objectives', async () => {
    const service = `dash-iso-${randomUUID().slice(0, 8)}`;
    await createSlo(app.db, tenantId, newSlo(service, `x-${randomUUID().slice(0, 8)}`));
    const rows = (await sloDashboard(app.db, otherTenantId)).filter((r) => r.service === service);
    expect(rows).toEqual([]);
  });
});

// Evaluation is best-effort by contract: a query the backend rejects writes no burn event and never
// dead-letters the job. That silence was the unfixed half of the availability-example trap. The read
// model now carries the reason, so every surface can tell "failing" apart from "new".
describe('a failing evaluation is visible on the read model', () => {
  test('the reason reaches the service read and the dashboard read', async () => {
    const service = `fail-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(app.db, tenantId, newSlo(service, `f-${randomUUID().slice(0, 8)}`));

    const [fresh] = await sloStatusForService(app.db, tenantId, service);
    expect(fresh!.lastEvaluationError).toBe(null);
    expect(fresh!.evaluationFailingSince).toBe(null);

    await recordEvalOutcome(app.db, tenantId, slo.id, 'query did not resolve to a numeric ratio');

    const [failing] = await sloStatusForService(app.db, tenantId, service);
    expect(failing!.lastEvaluationError).toBe('query did not resolve to a numeric ratio');
    expect(failing!.evaluationFailingSince).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const row = (await sloDashboard(app.db, tenantId)).find((r) => r.id === slo.id)!;
    expect(row.lastEvaluationError).toBe('query did not resolve to a numeric ratio');
  });

  test('a later success clears the reason, so a transient outage does not mark it broken forever', async () => {
    const service = `heal-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(app.db, tenantId, newSlo(service, `h-${randomUUID().slice(0, 8)}`));
    await recordEvalOutcome(app.db, tenantId, slo.id, 'backend unreachable');
    await recordEvalOutcome(app.db, tenantId, slo.id, null);

    const [healed] = await sloStatusForService(app.db, tenantId, service);
    expect(healed!.lastEvaluationError).toBe(null);
    // The pair always agrees: with no failure there is no failing-since time either.
    expect(healed!.evaluationFailingSince).toBe(null);
  });

  test('a stale figure is reported WITH the reason it stopped moving, not instead of it', async () => {
    // The failure line must never replace the last good number: a responder needs both the figure and
    // the fact that it is no longer being refreshed.
    const service = `both-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(app.db, tenantId, newSlo(service, `b-${randomUUID().slice(0, 8)}`));
    await recordBurnEvent(app.db, tenantId, {
      sloId: slo.id,
      budgetPct: 0.25,
      burnRate: 4,
      window: '1h',
    });
    await recordEvalOutcome(app.db, tenantId, slo.id, 'backend unreachable');

    const [view] = await sloStatusForService(app.db, tenantId, service);
    expect(view!.evaluation!.budgetRemaining).toBeCloseTo(0.25, 9);
    expect(view!.lastEvaluationError).toBe('backend unreachable');
  });
});

describe('renderSloBrief carries the failure to the responder', () => {
  test('an evaluated objective keeps its figures and gains the reason', () => {
    // The pair is always written together, so a fixture that sets one without the other would be
    // asserting a row the database cannot produce.
    const brief = renderSloBrief([
      view({
        lastEvaluationError: 'backend unreachable',
        evaluationFailingSince: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    expect(brief).toContain('Evaluation failing since 2026-01-01T00:00:00.000Z');
    expect(brief).toContain('backend unreachable');
    expect(brief).toContain('Measured');
  });

  test('a reason with no start time omits the clause rather than printing the word null', () => {
    // Defensive: the two fields are written together, so this shape should not occur. The brief is a
    // durable message a responder reads, and "failing since null" would be worse than saying nothing.
    const brief = renderSloBrief([
      view({ lastEvaluationError: 'backend unreachable', evaluationFailingSince: null }),
    ]);
    expect(brief).toContain('Evaluation failing: backend unreachable');
    expect(brief).not.toContain('null');
  });

  test('a never-evaluated objective says why it is still waiting', () => {
    const brief = renderSloBrief([
      view({
        evaluation: null,
        lastEvaluationError: 'query did not resolve to a numeric ratio',
        evaluationFailingSince: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    expect(brief).toContain('awaiting first evaluation.');
    expect(brief).toContain('query did not resolve to a numeric ratio');
  });

  test('a healthy objective gains no failure line at all', () => {
    expect(renderSloBrief([view()])).not.toContain('Evaluation failing');
  });

  test('a long message is flattened and truncated, so one bad objective cannot crowd out the incident', () => {
    const brief = renderSloBrief([
      view({
        lastEvaluationError: `first line\n${'x'.repeat(400)}`,
        evaluationFailingSince: '2026-01-01T00:00:00.000Z',
      }),
    ]);
    const line = brief.split('\n').find((l) => l.includes('Evaluation failing'))!;
    expect(line).toContain('first line x');
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(400);
  });
});
