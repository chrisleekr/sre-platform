import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { approvals, createIncident, getIncident, withTenant } from '@sre/db';

import { connectorToolKey, makeDbAuditSink, type ToolDefinition } from '@sre/agent-tools';

import * as z from 'zod';

import { type Job } from '@sre/queue';

import type { IDataSourceConnector } from '@sre/connectors';

import { approvalActionId } from '../engine/approval-id';

import { TriageWorker } from '../worker';

import {
  type ResumeInput,
  type TriageEngine,
  type TriageInput,
  type TriageResult,
  type TriageRuntime,
} from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker', () => {
  // --- proactive runbook seeding into the incident-open brief -------------------
  // The worker calls an injected `runbookSeeder(tenantId, { title, service, severity })` once, on the
  // OPEN path only, and prepends a "Related runbooks from past incidents" section (each: title +
  // "seen N×" confidence + full content) to the brief — into BOTH the hub opener AND the engine's
  // first-turn context. Best-effort: a seeder throw seeds nothing and never blocks the open. Resume
  // never re-seeds. The seeder query threads the classifier title from the job payload.
  type RunbookSeed = {
    title: string | null;
    content: string;
    occurrenceCount: number;
    verified: boolean;
  };

  type SeederFn = (
    tenantId: string,
    q: { title?: string; service: string; severity: string },
  ) => Promise<RunbookSeed[]>;

  // Build a worker with a capturing engine (records the first-turn TriageInput) and an injected
  // runbookSeeder. `runbookSeeder` is not yet on TriageWorkerDeps, so cast — RED until the worker
  // both accepts and consumes it.
  function seedWorker(seeder: SeederFn): {
    worker: TriageWorker;
    captured: () => TriageInput | undefined;
  } {
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
    const built = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
      runbookSeeder: seeder,
    } as unknown as ConstructorParameters<typeof TriageWorker>[0]);
    return { worker: built, captured: () => cap };
  }

  test('runtime binds per-connector tools + platform tools per tenant, absent for a tenant with no connectors (EARS 1/2)', async () => {
    // Capture the tools the worker hands the engine so we can assert the per-run binding.
    let capturedNames: string[] = [];
    const capturingEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(inp: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
        capturedNames = runtime.tools.map((t) => t.name);
        await runtime.onStep('finding', 'bound');
        return {
          provider: 'fake',
          sessionId: `fake:${inp.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 's',
          confidence: 50,
        };
      },
      async resume(inp: ResumeInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${inp.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 's',
          confidence: 50,
        };
      },
    };
    // A platform tool double (always bound) + a connector exposing one granular tool (bound as fake_probe).
    const platformTool: ToolDefinition<any, any> = {
      name: 'search_runbooks',
      description: 'semantic search',
      inputSchema: z.object({ query: z.string() }),
      handler: async () => ({ available: true, data: { hits: [] } }),
    };
    const withToolsConnector: IDataSourceConnector = {
      id: '00000000-0000-4000-8000-000000000004',
      name: 'Test GitLab',
      type: 'gitlab',
      snapshot: async () => [],
      fetchTriageContext: async () => ({ source: 'gitlab', data: {} }),
      tools: () => [
        {
          name: 'probe',
          description: 'probe',
          inputSchema: z.object({ service: z.string() }),
          run: async () => ({ ok: true }),
        },
      ],
      probe: async () => ({ status: 'healthy', reachable: true, authorized: true, warnings: [] }),
    };
    const connectorToolName = `gitlab_${connectorToolKey(withToolsConnector.id)}_probe`;

    // EARS 1: a tenant whose connector has tools() → the namespaced connector tool AND the platform tool.
    const { id: incWith } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'gitlab',
      service: 'checkout',
      severity: 'sev2',
    });
    const boundWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: capturingEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [withToolsConnector],
      tools: [platformTool],
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incWith },
    });
    expect(await boundWorker.tick('bind-1')).toBe(1);
    expect(capturedNames).toContain(connectorToolName);
    expect(capturedNames).toContain('search_runbooks');

    // EARS 2: a tenant that resolves to NO connectors binds only the platform tool. (Cross-tenant RLS
    // isolation — EARS 8 — is proven where it actually lives: connector-provider.test.ts, over the real
    // RLS-scoped makeDbConnectorProvider. The worker only forwards whatever that resolver returns.)
    capturedNames = [];
    const { id: incNone } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'gitlab',
      service: 'checkout',
      severity: 'sev2',
    });
    const bareWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: capturingEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: () => async () => [],
      tools: [platformTool],
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incNone },
    });
    expect(await bareWorker.tick('bind-2')).toBe(1);
    expect(capturedNames).toEqual(['search_runbooks']);
    expect(capturedNames).not.toContain(connectorToolName);
  });

  test('a job for a vanished incident is acked as a no-op', async () => {
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: randomUUID() },
    });
    const handled = await __fixture.worker.tick('t1');
    expect(handled).toBe(1);
  });

  // finding D: an unknown job type must not silently vanish. handle should warn (so a misrouted
  // producer is observable) without throwing (the delivery is still acked, not endlessly redelivered).
  test('handle logs a warning for an unknown job type', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        __fixture.worker.handle(
          {
            id: randomUUID(),
            tenantId: __fixture.tenantId,
            type: 'bogus',
            payload: {},
            attempts: 1,
          } as Job,
          { signal: new AbortController().signal },
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join(' ');
      expect(logged).toContain('bogus'); // identifies the offending type
    } finally {
      warn.mockRestore();
    }
  });

  test('seeds matched runbooks into the opener brief AND the first-turn engine context', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const seeder = vi.fn<SeederFn>(async () => [
      {
        title: 'DB pool exhaustion runbook',
        content: 'Restart pgbouncer.',
        occurrenceCount: 4,
        verified: true,
      },
    ]);
    const { worker: w, captured } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId, title: 'checkout is down' },
    });
    expect(await w.tick('seed-c2')).toBe(1);

    // The seeder was invoked once with the payload title + incident service/severity.
    expect(seeder).toHaveBeenCalledTimes(1);
    expect(seeder).toHaveBeenCalledWith(
      __fixture.tenantId,
      expect.objectContaining({ title: 'checkout is down', service: 'checkout', severity: 'sev2' }),
    );

    // (1) The runbook section is in the engine's first-turn context: header + title + "seen N×".
    expect(captured()?.context).toContain('Related runbooks from past incidents');
    expect(captured()?.context).toContain('DB pool exhaustion runbook');
    expect(captured()?.context).toContain('seen 4×');

    // (2) The same section landed in the hub opener brief.
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const brief = history.find((m) => m.content.includes('Related runbooks from past incidents'));
    expect(brief).toBeDefined();
    expect(brief!.content).toContain('DB pool exhaustion runbook');
    expect(brief!.content).toContain('seen 4×');
  });

  test('preserves seed order (highest-first) and includes full content untruncated', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    // A long (>300 char) second runbook body, to prove no truncation/ellipsis is applied.
    const longContent = `Full remediation steps: ${'step '.repeat(80)}end.`;
    expect(longContent.length).toBeGreaterThan(300);
    const seeder = vi.fn<SeederFn>(async () => [
      {
        title: 'High-recurrence runbook',
        content: 'Primary fix.',
        occurrenceCount: 9,
        verified: true,
      },
      { title: 'Detailed runbook', content: longContent, occurrenceCount: 2, verified: false },
    ]);
    const { worker: w, captured } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });
    expect(await w.tick('seed-c2-order')).toBe(1);

    const ctx = captured()?.context ?? '';
    // Order preserved: the higher-occurrence seed is listed first ("1. " before "2. ").
    expect(ctx.indexOf('1. ')).toBeGreaterThanOrEqual(0);
    expect(ctx.indexOf('1. ')).toBeLessThan(ctx.indexOf('2. '));
    expect(ctx.indexOf('High-recurrence runbook')).toBeLessThan(ctx.indexOf('Detailed runbook'));
    // Full content verbatim, no truncation/ellipsis.
    expect(ctx).toContain(longContent);
    expect(ctx).not.toContain('…');
  });

  test('nothing clears the floor → no runbook section (silent cold-start)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const seeder = vi.fn<SeederFn>(async () => []);
    const { worker: w, captured } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });
    expect(await w.tick('seed-c3')).toBe(1);

    expect(captured()?.context).not.toContain('Related runbooks from past incidents');
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.some((m) => m.content.includes('Related runbooks from past incidents'))).toBe(
      false,
    );
  });

  test('a seeder failure seeds nothing but still opens the incident (best-effort)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const seeder = vi.fn<SeederFn>(async () => {
      throw new Error('embedder unavailable');
    });
    const { worker: w } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });
    expect(await w.tick('seed-c4')).toBe(1);

    // The open proceeds normally: progress gathers, the brief posts, but no runbook section is seeded.
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('assessed');
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.some((m) => m.content.includes('Triage started'))).toBe(true);
    expect(history.some((m) => m.content.includes('Blast radius for'))).toBe(true);
    expect(history.some((m) => m.content.includes('Related runbooks from past incidents'))).toBe(
      false,
    );
  });

  // C7 — the opener computes blastRadius and runbookSection independently and best-effort.
  // When one (the runbook seed) throws, the other (blast radius) still reaches the hub, triage still
  // opens, and the raw failure text is NEVER leaked into the conversation (CWE-209). This characterises
  // the independence the Promise.all parallelisation must preserve. (The concurrency itself is not
  // behaviourally observable, so it is not asserted here.)
  test('C7: a runbook-seed failure does not abort the blast-radius brief or leak raw error text', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const secret = `pg://user:s3cr3t@10.0.0.9/db-${randomUUID()}`;
    const seeder = vi.fn<SeederFn>(async () => {
      throw new Error(`seed query failed: ${secret}`);
    });
    const { worker: w } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'triage',
      payload: { incidentId: incId },
    });
    expect(await w.tick('c7-independence')).toBe(1);

    // Triage opened with the blast-radius section despite the seeder throwing (independence preserved).
    expect(
      (await getIncident(__fixture.app.db, __fixture.tenantId, incId))?.investigationStatus,
    ).toBe('assessed');
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.some((m) => m.content.includes('Blast radius for'))).toBe(true);
    // No raw error/connection string ever reaches the conversation.
    expect(history.some((m) => m.content.includes(secret))).toBe(false);
    expect(history.some((m) => m.content.includes('seed query failed'))).toBe(false);
  });

  test('a resume job never re-seeds runbooks', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    const humanMsg = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'any runbooks?',
    });
    const seeder = vi.fn<SeederFn>(async () => []);
    const { worker: w } = seedWorker(seeder);

    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: humanMsg.id },
    });
    expect(await w.tick('seed-c5')).toBe(1);

    expect(seeder).not.toHaveBeenCalled();
  });

  // C1b: persistDisposition for a disposition:'approval' result must (a) create a single
  // approvals row (idempotency key actionId) carrying the prompt+options, and (b) append a kind
  // 'approval' hub message LINKED to that row via approvalId, carrying its options. RED today:
  // 'approval' is not in the disposition union, so persistDisposition falls through to the rca path —
  // no approvals row, no kind='approval' message.
  test("C1b: an 'approval' disposition creates an approvals row and appends a linked kind='approval' message", async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const prompt = 'Restart checkout?';
    const options = [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ];
    // An engine that terminates the loop by requesting approval. The engine returns only
    // the { prompt, options } proposal; the worker owns the action_id. Cast through unknown for the fake.
    const approvalEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
        await runtime.onStep('text', 'proposing an action');
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'approval',
          summary: prompt,
          confidence: 0,
          approval: { prompt, options },
        } as unknown as TriageResult;
      },
      async resume(input: ResumeInput): Promise<TriageResult> {
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
    const apprWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: approvalEngine,
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
      payload: { incidentId: incId },
    });
    expect(await apprWorker.tick('appr-c1b')).toBe(1);

    // (a) exactly one approvals row, its action_id the hash of the (scrubbed) prompt+options the worker
    // derives, carrying the prompt + options.
    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actionId).toBe(approvalActionId(prompt, options));
    expect(rows[0]!.prompt).toBe(prompt);
    expect(rows[0]!.options).toEqual(options);

    // (b) a kind='approval' hub message linked to the row (approvalId) and carrying its options.
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const appr = history.find((m) => m.kind === 'approval');
    expect(appr).toBeDefined();
    expect(appr!.approvalId).toBe(rows[0]!.id);
    expect(appr!.approval?.options).toEqual(options);
  });
});
