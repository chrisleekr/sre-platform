// C5 — the incident-opening brief carries the service's remaining error budget, and the budget read
// can never degrade the opener. The budget is CONTEXT for a responder, not a trigger: nothing here
// opens, escalates or blocks anything on account of a burning budget. [read model, never an ingress]
//
// Live infra via the shared worker fixture (Postgres + Valkey + hub), because the assertion is what
// actually reaches the conversation and the engine's first prompt.
import { describe, expect, test, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createIncident, createSlo, recordBurnEvent, slos } from '@sre/db';
import { withRoleDdlLock } from '@sre/db/test-support';
import { makeDbAuditSink } from '@sre/agent-tools';
import { TriageWorker } from '../worker';
import type { TriageEngine, TriageInput, TriageResult, TriageRuntime } from '../engine/types';
import { createFixture } from './worker.fixture';

// Not a test of the per-tenant ceiling, so these create under a cap they never reach.
const SLO_CAP = 1_000;

const __fixture = createFixture();

const newSlo = (service: string, name: string) => ({
  name,
  service,
  sliType: 'availability' as const,
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
});

/** A worker with a capturing engine, so the engine's first-turn context can be asserted too. */
function briefWorker(): { worker: TriageWorker; captured: () => TriageInput | undefined } {
  let cap: TriageInput | undefined;
  const engine: TriageEngine = {
    provider: 'fake',
    verifyRecovery: __fixture.verifyRecovery,
    async investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
      cap = input;
      await runtime.onStep('finding', 'c');
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 1,
        summary: 's',
        confidence: 50,
      };
    },
    async resume(input: TriageInput): Promise<TriageResult> {
      cap = input;
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 1,
        summary: 's',
        confidence: 50,
      };
    },
  };
  const worker = new TriageWorker({
    appDb: __fixture.app.db,
    hub: __fixture.hub,
    engine,
    queue: __fixture.queue,
    auditSink: makeDbAuditSink({ db: __fixture.app.db }),
    connectorProvider: __fixture.connectorProvider,
    tools: __fixture.tools,
    lock: __fixture.engineLock,
    clearResumeGate: async () => {},
  });
  return { worker, captured: () => cap };
}

async function openIncidentFor(service: string): Promise<string> {
  const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
    fingerprint: `fp-${randomUUID()}`,
    alertSource: 'datadog',
    service,
    severity: 'sev2',
  });
  return id;
}

// Deterministic regardless of hook ordering: afterEach always precedes the fixture's afterAll, which
// deletes the tenant these objectives reference.
afterEach(async () => {
  await __fixture.admin.db.delete(slos).where(sql`tenant_id = ${__fixture.tenantId}`);
});

describe('C5: the opener brief carries the error budget', () => {
  test('an evaluated objective reaches both the hub opener and the engine first prompt', async () => {
    const service = `budget-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      __fixture.app.db,
      __fixture.tenantId,
      newSlo(service, `avail-${randomUUID().slice(0, 8)}`),
      SLO_CAP,
    );
    await recordBurnEvent(__fixture.app.db, __fixture.tenantId, {
      sloId: slo.id,
      budgetPct: 0.25,
      burnRate: 4,
      window: '1h',
    });
    const incidentId = await openIncidentFor(service);
    const { worker, captured } = briefWorker();

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId },
    });
    expect(await worker.tick('budget-brief')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    const brief = history.find((m) => m.content.includes('SLO status:'));
    expect(brief, 'the opener brief must carry the budget section').toBeDefined();
    expect(brief!.author).toBe('system');
    expect(brief!.content).toContain(slo.name);
    expect(brief!.content).toContain('25.0% budget remaining');
    expect(brief!.content).toContain('burn 4.0x over 1h');
    // The blast radius still leads the brief: the budget is appended, not substituted.
    expect(brief!.content).toContain('Blast radius for');
    expect(brief!.content.indexOf('Blast radius for')).toBeLessThan(
      brief!.content.indexOf('SLO status:'),
    );
    // The same brief reaches the engine's first turn.
    expect(captured()?.context).toContain('SLO status:');
    expect(captured()?.context).toContain('25.0% budget remaining');
  });

  test('an unevaluated objective is reported as awaiting evaluation, never as a number', async () => {
    const service = `pending-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      __fixture.app.db,
      __fixture.tenantId,
      newSlo(service, `pend-${randomUUID().slice(0, 8)}`),
      SLO_CAP,
    );
    const incidentId = await openIncidentFor(service);
    const { worker } = briefWorker();

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId },
    });
    expect(await worker.tick('budget-pending')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    const brief = history.find((m) => m.content.includes('SLO status:'))!;
    expect(brief.content).toContain(slo.name);
    expect(brief.content).toContain('awaiting first evaluation');
    expect(brief.content).not.toMatch(/budget remaining/);
  });

  test('a service with no objective opens exactly as it does today: no budget section at all', async () => {
    const service = `nobudget-${randomUUID().slice(0, 8)}`;
    const incidentId = await openIncidentFor(service);
    const { worker, captured } = briefWorker();

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId },
    });
    expect(await worker.tick('budget-absent')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    // The brief is byte-identical to the pre-budget brief: the section is dropped, not rendered empty
    // and not rendered as a "no SLOs" line the engine would have to reason about.
    const brief = history.find((m) => m.content.includes('Blast radius for'))!;
    expect(brief.content).not.toContain('SLO status');
    expect(brief.content.trimEnd()).toBe(brief.content);
    expect(captured()?.context).not.toContain('SLO status');
    // And the incident still opens.
    expect(history.some((m) => m.content.includes('Triage started'))).toBe(true);
  });

  test('the budget never opens, escalates or blocks anything: it is advisory text only', async () => {
    const service = `exhausted-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      __fixture.app.db,
      __fixture.tenantId,
      newSlo(service, `gone-${randomUUID().slice(0, 8)}`),
      SLO_CAP,
    );
    // Fully over budget: the state that would tempt an automatic page.
    await recordBurnEvent(__fixture.app.db, __fixture.tenantId, {
      sloId: slo.id,
      budgetPct: -0.5,
      burnRate: 20,
      window: '1h',
    });
    const incidentId = await openIncidentFor(service);
    const { worker } = briefWorker();
    const [before] = await __fixture.admin.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM incidents WHERE tenant_id = ${__fixture.tenantId}
    `;

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId },
    });
    expect(await worker.tick('budget-exhausted')).toBe(1);

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    const brief = history.find((m) => m.content.includes('SLO status:'))!;
    expect(brief.content).toContain('budget EXHAUSTED (over by 50.0%)');
    // No second incident was minted from the burning budget.
    const [after] = await __fixture.admin.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM incidents WHERE tenant_id = ${__fixture.tenantId}
    `;
    expect(after!.n).toBe(before!.n);
  });

  test('a budget-read failure leaves the opener untouched and leaks no error text', async () => {
    const service = `readfail-${randomUUID().slice(0, 8)}`;
    const slo = await createSlo(
      __fixture.app.db,
      __fixture.tenantId,
      newSlo(service, `rf-${randomUUID().slice(0, 8)}`),
      SLO_CAP,
    );
    await recordBurnEvent(__fixture.app.db, __fixture.tenantId, {
      sloId: slo.id,
      budgetPct: 0.25,
      burnRate: 4,
      window: '1h',
    });
    const incidentId = await openIncidentFor(service);
    const { worker } = briefWorker();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    // A realistic read failure: the login role loses SELECT on `slos` for the duration of the open.
    // The opener must proceed with the blast radius alone rather than fail the incident.
    const roleRows = await __fixture.app.sql<Array<{ current_user: string }>>`SELECT current_user`;
    const loginRole = roleRows[0]!.current_user;
    await withRoleDdlLock(__fixture.admin.sql, (tx) =>
      tx.unsafe(`REVOKE SELECT ON slos FROM "${loginRole}"`),
    );
    try {
      await __fixture.queue.enqueue({
        tenantId: __fixture.tenantId,
        type: 'triage',
        payload: { incidentId },
      });
      expect(await worker.tick('budget-readfail')).toBe(1);
    } finally {
      await withRoleDdlLock(__fixture.admin.sql, (tx) =>
        tx.unsafe(`GRANT SELECT ON slos TO "${loginRole}"`),
      );
      errors.mockRestore();
    }

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    expect(history.some((m) => m.content.includes('Triage started'))).toBe(true);
    expect(history.some((m) => m.content.includes('Blast radius for'))).toBe(true);
    // Degraded silently: no budget section, and no raw database error in the conversation.
    expect(history.some((m) => m.content.includes('SLO status'))).toBe(false);
    expect(history.some((m) => /permission denied/i.test(m.content))).toBe(false);
  });
});
