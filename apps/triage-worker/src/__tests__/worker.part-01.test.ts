import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  addDependency,
  agentToolCalls,
  createIncident,
  getIncident,
  upsertService,
  withTenant,
} from '@sre/db';

import { connectorToolKey, makeDbAuditSink } from '@sre/agent-tools';

import * as z from 'zod';

import type { IDataSourceConnector } from '@sre/connectors';

import { makeClaudeEngine, type AnthropicLike } from '../engine/claude';

import { TriageWorker } from '../worker';

import {
  type TriageEngine,
  type TriageInput,
  type TriageResult,
  type TriageRuntime,
} from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker', () => {
  // Build a worker with a capturing engine (records the first-turn TriageInput) and an injected
  // runbookSeeder. `runbookSeeder` is not yet on TriageWorkerDeps, so cast — RED until the worker
  // both accepts and consumes it.

  test('runs the engine: progress reaches assessed, RCA persists, hub gets the transcript', async () => {
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: __fixture.incidentId, alert: { fingerprint: 'x' } },
    });

    const handled = await __fixture.worker.tick('t1');
    expect(handled).toBe(1);

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, __fixture.incidentId);
    expect(inc).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      engineProvider: 'fake',
    });
    expect(inc!.engineSessionId).toBe(`fake:${__fixture.incidentId}`);
    expect(inc!.confidence).toBe(50);
    expect(inc!.rcaSummary).toContain('checkout');
    // RCA persistence: the engine model and ranked hypotheses round-trip onto the incident.
    expect(inc!.engineModel).toBe('fake');
    expect(inc!.rankedHypotheses).toEqual([
      {
        hypothesis: 'Recent deploy to checkout introduced a regression.',
        confidence: 50,
        evidence: 'Alert on checkout correlates with a deploy window.',
      },
    ]);

    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    // Atomic opener: "Triage started" is persisted by startInvestigatingWithMessages and
    // fanned out via publishPersisted — exactly once.
    expect(
      history.filter((m) => m.author === 'system' && m.content.includes('Triage started')),
    ).toHaveLength(1);
    // The engine streams its steps via onStep; the worker no longer double-appends a finding.
    expect(history.some((m) => m.kind === 'tool_step')).toBe(true);
    expect(history.filter((m) => m.kind === 'finding')).toHaveLength(1);
    expect(history.find((m) => m.kind === 'finding')?.finding).toMatchObject({
      outcome: 'conclusive',
      promotion: 'trusted_assessment',
      promotionReason: 'conclusive_assessment',
    });

    // Redelivery loses the queued-progress CAS, so the opener is not re-posted.
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: __fixture.incidentId, alert: { fingerprint: 'x' } },
    });
    expect(await __fixture.worker.tick('t1-redelivery')).toBe(1);
    const afterRedeliver = await __fixture.hub.history(__fixture.tenantId, __fixture.incidentId);
    expect(
      afterRedeliver.filter((m) => m.author === 'system' && m.content.includes('Triage started')),
    ).toHaveLength(1);
  });

  test('persists redacted unknowns and next step from the engine result', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz1234';
    const resultEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${id}`,
          model: 'fake-evidence',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'rca',
          summary: 'Connection pool saturation is the leading cause.',
          confidence: 72,
          unknowns: [
            {
              question: `Whether ${secret} was rotated`,
              category: 'operator_decision',
              evidenceKind: null,
              attemptedEvidenceIds: [],
            },
          ],
          nextStep: `Compare the pool config using ${secret}`,
        };
      },
      async resume(): Promise<TriageResult> {
        throw new Error('resume is not used by this test');
      },
    };
    const resultWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: resultEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: id, alert: { fingerprint: 'redacted-fields' } },
    });

    expect(await resultWorker.tick('redacted-fields')).toBe(1);
    const incident = await getIncident(__fixture.app.db, __fixture.tenantId, id);
    expect(incident).toMatchObject({
      engineModel: 'fake-evidence',
      unknowns: [
        {
          question: 'Whether [REDACTED] was rotated',
          category: 'operator_decision',
          evidenceKind: null,
          attemptedEvidenceIds: [],
        },
      ],
      nextStep: 'Compare the pool config using [REDACTED]',
    });
  });

  test('auto-injects the blast-radius brief into the first hub message and the engine prompt', async () => {
    // Seed a tiny graph: br_web calls br_checkout synchronously, so br_web is a direct dependent.
    await upsertService(__fixture.app.db, __fixture.tenantId, {
      name: 'br_checkout',
      criticality: 'tier1',
      team: 'payments',
    });
    await upsertService(__fixture.app.db, __fixture.tenantId, {
      name: 'br_web',
      criticality: 'tier1',
      team: 'web',
    });
    await addDependency(__fixture.app.db, __fixture.tenantId, {
      upstream: 'br_web',
      downstream: 'br_checkout',
    });
    const { id: brIncidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'br_checkout',
      severity: 'sev2',
    });
    // A capturing engine records the first prompt input so we can assert the brief was injected.
    let captured: TriageInput | undefined;
    const capturingEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
        captured = input;
        await runtime.onStep('finding', 'captured');
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
    const brWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: capturingEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: brIncidentId },
    });
    expect(await brWorker.tick('br')).toBe(1);

    // (1) The blast-radius brief is in the hub at alert time (M3 exit criterion).
    const history = await __fixture.hub.history(__fixture.tenantId, brIncidentId);
    const brief = history.find((m) => m.content.includes('Blast radius for'));
    expect(brief).toBeDefined();
    expect(brief!.author).toBe('system');
    expect(brief!.content).toContain('br_web'); // the direct dependent is listed

    // (2) The same brief is injected into the engine's first prompt (the agent sees it first).
    expect(captured?.context).toContain('Blast radius for');
    expect(captured?.context).toContain('br_web');
  });

  test('a Slack-originated incident receives correlated first-pass evidence from every enabled connector', async () => {
    const { id } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'correlated-checkout',
      severity: 'sev2',
    });
    const githubFetch = vi.fn(async () => ({
      source: 'github' as const,
      data: { repositories: [{ repo: 'acme/checkout', sha: 'abc123' }] },
    }));
    const kubernetesFetch = vi.fn(async () => ({
      source: 'kubernetes' as const,
      data: { pods: [{ name: 'checkout-1', phase: 'Running' }] },
    }));
    const connector = (
      type: 'github' | 'kubernetes',
      fetchTriageContext: IDataSourceConnector['fetchTriageContext'],
    ): IDataSourceConnector => ({
      id:
        type === 'github'
          ? '00000000-0000-4000-8000-000000000001'
          : '00000000-0000-4000-8000-000000000002',
      name: `Test ${type}`,
      type,
      snapshot: async () => [],
      fetchTriageContext,
      tools: () => [],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    });
    let captured: TriageInput | undefined;
    const engine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input): Promise<TriageResult> {
        captured = input;
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 'correlated evidence captured',
          confidence: 70,
        };
      },
      async resume(): Promise<TriageResult> {
        throw new Error('resume is not used');
      },
    };
    const correlatedWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [
        connector('github', githubFetch),
        connector('kubernetes', kubernetesFetch),
      ],
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: id },
    });
    expect(await correlatedWorker.tick('correlated-first-pass')).toBe(1);
    expect(githubFetch).toHaveBeenCalledWith({ service: 'correlated-checkout', windowMinutes: 60 });
    expect(kubernetesFetch).toHaveBeenCalledWith({
      service: 'correlated-checkout',
      windowMinutes: 60,
    });
    const modelEvidence = JSON.stringify(captured?.evidence ?? []);
    expect(modelEvidence).toContain('acme/checkout');
    expect(modelEvidence).toContain('checkout-1');

    const evidence = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select()
        .from(agentToolCalls)
        .where(
          sql`${agentToolCalls.incidentId} = ${id} and ${agentToolCalls.tool} = 'fetch_triage_context'`,
        ),
    );
    expect(evidence).toHaveLength(1);
    expect(captured?.evidence).toEqual([
      expect.objectContaining({ id: evidence[0]!.id, tool: 'fetch_triage_context' }),
    ]);
    expect(evidence[0]!.output).toMatchObject({
      sources: [{ source: 'github' }, { source: 'kubernetes' }],
      unavailable: [],
    });
  });

  test('drives the real Claude loop: interleaved tool_step rows + an audited tool call under the tenant', async () => {
    // The tenant's connector exposes a granular `metrics` tool under its immutable source identity.
    const metricsConnector: IDataSourceConnector = {
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Test Datadog',
      type: 'datadog',
      snapshot: async () => [],
      fetchTriageContext: async () => ({ source: 'datadog', data: {} }),
      tools: () => [
        {
          name: 'metrics',
          description: 'fetch golden-signal metrics',
          inputSchema: z.object({ service: z.string(), windowMinutes: z.number() }),
          run: async () => ({ saturation: 0.98 }),
        },
      ],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
    const metricsToolName = `datadog_${connectorToolKey(metricsConnector.id)}_metrics`;
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'm1',
            name: metricsToolName,
            input: { service: 'checkout', windowMinutes: 30 },
          },
        ],
      })
      .mockResolvedValueOnce({
        stop_reason: 'tool_use',
        content: [
          {
            type: 'tool_use',
            id: 'm2',
            name: 'report_findings',
            input: {
              outcome: 'conclusive',
              summary: 'DB pool exhausted on checkout',
              confidence: 77,
              rankedHypotheses: [
                { hypothesis: 'pool exhaustion', confidence: 77, evidence: 'metrics saturation' },
              ],
            },
          },
        ],
      });
    const sdk: AnthropicLike = { messages: { create } };
    const claudeWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk),
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [metricsConnector],
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: __fixture.claudeIncidentId, alert: { fingerprint: 'y' } },
    });
    const handled = await claudeWorker.tick('claude-1');
    expect(handled).toBe(1);
    expect(create).toHaveBeenCalledTimes(2);

    const inc = await getIncident(__fixture.app.db, __fixture.tenantId, __fixture.claudeIncidentId);
    expect(inc).toMatchObject({
      status: 'open',
      investigationStatus: 'assessed',
      engineProvider: 'claude',
    });
    expect(inc!.engineModel).toBe('claude-opus-4-8');
    expect(inc!.confidence).toBe(77);
    expect(inc!.rcaSummary).toContain('DB pool exhausted');
    expect(inc!.rankedHypotheses).toEqual([
      {
        hypothesis: 'pool exhaustion',
        confidence: 77,
        evidence: 'metrics saturation',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ]);

    // The loop streamed the instance-scoped tool step before the terminal finding.
    const history = await __fixture.hub.history(__fixture.tenantId, __fixture.claudeIncidentId);
    const toolStep = history.find((m) => m.kind === 'tool_step');
    const finding = history.find((m) => m.kind === 'finding');
    expect(toolStep?.content).toContain(metricsToolName);
    expect(finding?.content).toContain('DB pool exhausted');
    expect(finding?.finding).toMatchObject({
      promotion: 'trusted_assessment',
      evidenceIds: expect.any(Array),
    });
    expect(history.indexOf(toolStep!)).toBeLessThan(history.indexOf(finding!));

    // At least one audited tool call landed under the correct tenant.
    const calls = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select()
        .from(agentToolCalls)
        .where(eq(agentToolCalls.incidentId, __fixture.claudeIncidentId)),
    );
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.some((c) => c.tool === metricsToolName)).toBe(true);
    expect(calls.every((c) => c.tenantId === __fixture.tenantId)).toBe(true);
  });
});
