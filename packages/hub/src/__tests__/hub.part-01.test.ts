import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  agentToolCalls,
  applySignalObservation,
  createApproval,
  createIncident,
  getIncident,
  incidents,
  jobs,
  recordToolCall,
  serializeSignalFence,
  withTenant,
} from '@sre/db';

import { type HubMessage } from '../hub';

import { createFixture } from './hub.fixture';

const __fixture = createFixture();

describe('ConversationHub', () => {
  test.each(['status', 'reply', 'clarification_request', 'degraded_reask', 'silent'] as const)(
    'accepts the new %s message kind and round-trips it',
    async (kind) => {
      const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
        author: 'agent',
        kind,
        content: `content-${kind}`,
      });
      expect(m.kind).toBe(kind);
      const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
      expect(hist.find((h) => h.id === m.id)?.kind).toBe(kind);
    },
  );

  test('append then history returns the message (tenant-scoped)', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'investigating blast radius',
    });
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.map((h) => h.id)).toContain(m.id);
    expect(hist.at(-1)?.content).toBe('investigating blast radius');
  });

  test('append persists and returns originSurface; history reflects it', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'human',
      content: 'typed in slack',
      originSurface: 'slack',
    });
    expect(m.originSurface).toBe('slack');
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.originSurface).toBe('slack');
  });

  test('originSurface defaults to null when omitted (agent/system posts)', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'no origin',
    });
    expect(m.originSurface).toBeNull();
  });

  test('C1: append persists and returns authorUserId; history reflects it', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'human',
      content: 'attributed slack reply',
      originSurface: 'slack',
      authorUserId: __fixture.memberUserId,
    });
    expect(m.authorUserId).toBe(__fixture.memberUserId);
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.authorUserId).toBe(__fixture.memberUserId);
  });

  test('C7: appendTx without authorUserId → author_user_id null (default)', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'no author id',
    });
    expect(m.authorUserId ?? null).toBeNull();
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.authorUserId ?? null).toBeNull();
  });

  test('an approval message carries the approval payload transiently (not persisted)', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'system',
      kind: 'approval',
      content: 'Restart the service?',
      approval: {
        id: 'appr-1',
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    });
    expect(m.approval?.id).toBe('appr-1');
    expect(m.approval?.options).toHaveLength(2);
    // Transient: history (read from the DB, which has no approval column) does not carry it.
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.approval).toBeUndefined();
  });

  // C2: durable approval replay. An approval message links to its approvals row via a new
  // `approvalId` column; history() LEFT JOINs approvals and re-attaches `approval:{id, options}` from
  // the durable row (today toHubMessage drops the transient approval, so a reload replays as plain
  // text). Seed the row via createApproval, append linked to it, then reload and assert options survive.
  test('C2: appendTx persists+returns approvalId, and history durably re-attaches approval options', async () => {
    const actionId = `act-${randomUUID().slice(0, 8)}`;
    const options = [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ];
    // createApproval reports whether it inserted; this test only needs the row.
    const { row } = await createApproval(__fixture.app.db, __fixture.tenantA, {
      incidentId: __fixture.incidentId,
      actionId,
      prompt: 'Restart the service?',
      options,
    });

    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      kind: 'approval',
      content: 'Restart the service?',
      // The new durable link (RED until incident_messages gains approval_id + NewMessage gains approvalId).
      approvalId: row.id,
      approval: { id: row.id, options },
    });
    // appendTx persists the link and returns it on the HubMessage.
    expect(m.approvalId).toBe(row.id);

    // Durable replay: reloaded from Postgres (no in-memory transient), history joins approvals and
    // re-attaches the options — NOT dropped to plain text.
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    const replayed = hist.find((h) => h.id === m.id);
    expect(replayed?.approvalId).toBe(row.id);
    expect(replayed?.approval?.options).toEqual(options);
  });

  test('a pending approval blocks low-risk automatic resolution without dropping recovery evidence', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `pending-approval-recovery-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev3',
      })
    ).id;
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-approval-recovery',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'Checkout alert resolved',
      contentHash: randomUUID(),
      eventKey: `resolved-${randomUUID()}`,
      eventAt: new Date(),
    });
    await createApproval(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      actionId: `restart-${randomUUID()}`,
      prompt: 'Restart checkout?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
    });

    const staleEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    await __fixture.admin.db
      .update(agentToolCalls)
      .set({ createdAt: new Date('2026-08-20T23:59:59.000Z') })
      .where(eq(agentToolCalls.id, staleEvidenceId));
    await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx
        .update(incidents)
        .set({
          recoveryState: 'verifying',
          recoveryUpdatedAt: new Date('2026-08-21T00:00:00.000Z'),
        })
        .where(eq(incidents.id, id)),
    );
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const failedEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      latencyMs: 1,
      outcome: 'error',
    });
    const siblingIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `recovery-sibling-${randomUUID()}`,
        alertSource: 'slack',
        service: 'payments',
        severity: 'sev3',
      })
    ).id;
    const siblingEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: siblingIncidentId,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const foreignIncidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantB, {
        fingerprint: `recovery-foreign-${randomUUID()}`,
        alertSource: 'slack',
        service: 'private-payments',
        severity: 'sev3',
      })
    ).id;
    const foreignEvidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantB, {
      incidentId: foreignIncidentId,
      tool: 'prometheus_query_range',
      input: { query: 'up' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const result = await __fixture.hub.finalizeRecovery(__fixture.tenantA, id, {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([cleared.signal]),
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt: new Date('2026-08-21T00:00:00.000Z'),
      eventKey: `recovery:${randomUUID()}`,
      content: 'Recovery verified from current telemetry.',
      summary: 'Checkout is healthy.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [
        staleEvidenceId,
        failedEvidenceId,
        siblingEvidenceId,
        foreignEvidenceId,
        evidenceId,
        randomUUID(),
      ],
      recoveryUnknowns: [],
      recoveryNextStep: null,
      recoveryChecks: [{ name: 'Checkout health', before: 'Alerting', now: 'Healthy' }],
      assessedMaterials: [],
      autoResolve: {
        reason: 'Provider signals cleared and recovery verification passed.',
        transitionKey: `auto-resolve:${randomUUID()}`,
      },
    });

    expect(result).toMatchObject({ applied: true, retryable: false, autoResolved: false });
    expect(result.message?.recovery).toEqual({
      recovered: true,
      outcome: 'recovered',
      checks: [{ name: 'Checkout health', before: 'Alerting', now: 'Healthy' }],
      unknowns: [],
      nextStep: null,
      attempt: 1,
      maxChecks: 3,
      nextCheckAt: null,
      scheduleReason: null,
    });
    expect(result.lifecycleMessage).toBeNull();
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      status: 'open',
      lifecycleVersion: 0,
      investigationStatus: 'assessed',
      recoveryState: 'verified',
      recoveryEvidenceIds: [evidenceId],
    });

    const invalid = await __fixture.hub.finalizeRecovery(__fixture.tenantA, id, {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([cleared.signal]),
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt: new Date('2026-08-21T00:00:00.000Z'),
      eventKey: `recovery:${randomUUID()}`,
      content: 'Model claimed recovery from a fabricated reference.',
      summary: 'Checkout is healthy.',
      outcome: 'recovered',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [randomUUID()],
      recoveryUnknowns: ['Whether checkout remained healthy.'],
      recoveryNextStep: 'Run the checkout synthetic again.',
      recoveryChecks: [{ name: 'Checkout health', before: 'Alerting', now: 'Healthy' }],
      assessedMaterials: [],
    });
    expect(invalid.message?.recovery).toMatchObject({ recovered: false, checks: [] });
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      recoveryState: 'not_verified',
      recoveryEvidenceIds: [],
      recoverySummary: 'Recovery could not be verified because cited evidence was unavailable.',
      recoveryUnknowns: ['Cited recovery evidence was unavailable.'],
      recoveryNextStep:
        'Run a current health check and cite its durable evidence before resolving.',
    });
  });

  test('commits model-directed monitoring and its delayed successor atomically', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `scheduled-recovery-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev3',
      })
    ).id;
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-scheduled-recovery',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'Checkout alert resolved',
      contentHash: randomUUID(),
      eventKey: `resolved-${randomUUID()}`,
      eventAt: new Date(),
    });
    const verificationStartedAt = new Date(Date.now() - 1_000);
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      tool: 'prometheus_query_range',
      input: { query: 'checkout_errors' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const nextCheckAt = new Date(Date.now() + 5 * 60_000);

    const result = await __fixture.hub.finalizeRecovery(__fixture.tenantA, id, {
      expectedLifecycleVersion: 0,
      expectedSignalFence: serializeSignalFence([cleared.signal]),
      restoreInvestigationStatus: 'assessed',
      verificationStartedAt,
      eventKey: `recovery:${randomUUID()}`,
      content: 'Latency is improving; monitor recovery again after the rollout settles.',
      summary: 'Latency remains elevated but is trending down.',
      outcome: 'recheck',
      attempt: 1,
      maxChecks: 3,
      recoveryEvidenceIds: [evidenceId],
      recoveryUnknowns: [],
      recoveryNextStep: 'Recheck checkout latency after the rollout settles.',
      recoveryChecks: [{ name: 'Checkout latency', before: '2.1s', now: '800ms' }],
      assessedMaterials: [],
      scheduleRecheck: {
        nextCheckAt,
        reason: 'The deployment is still converging.',
        enqueueTx: async (tx) => {
          await tx.insert(jobs).values({
            tenantId: __fixture.tenantA,
            type: 'recovery.verify',
            payload: { incidentId: id, attempt: 2, maxChecks: 3 },
            status: 'queued',
            stream: 'sre:jobs',
            availableAt: nextCheckAt,
          });
        },
      },
    });

    expect(result).toMatchObject({ applied: true, autoResolved: false });
    expect(result.message).toMatchObject({
      kind: 'status',
      recovery: {
        outcome: 'recheck',
        recovered: false,
        attempt: 1,
        maxChecks: 3,
        nextCheckAt: nextCheckAt.toISOString(),
        scheduleReason: 'The deployment is still converging.',
      },
    });
    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      status: 'open',
      recoveryState: 'monitoring',
      recoveryAttempt: 1,
      recoveryMaxChecks: 3,
      recoveryNextCheckAt: nextCheckAt,
      recoveryScheduleReason: 'The deployment is still converging.',
    });
    expect(
      (
        await __fixture.admin.db
          .select()
          .from(jobs)
          .where(sql`payload->>'incidentId' = ${id}`)
      )[0],
    ).toMatchObject({ status: 'queued', availableAt: nextCheckAt });
  });

  test('rolls back monitoring state and its successor when scheduling cannot commit', async () => {
    const id = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `scheduled-recovery-rollback-${randomUUID()}`,
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev3',
      })
    ).id;
    const cleared = await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      surface: 'slack',
      channel: 'C-scheduled-recovery-rollback',
      externalMessageId: `resolved-${randomUUID()}`,
      state: 'resolved',
      summary: 'Checkout alert resolved',
      contentHash: randomUUID(),
      eventKey: `resolved-${randomUUID()}`,
      eventAt: new Date(),
    });
    const evidenceId = await recordToolCall(__fixture.app.db, __fixture.tenantA, {
      incidentId: id,
      tool: 'prometheus_query_range',
      input: { query: 'checkout_errors' },
      output: { data: { resultType: 'matrix', result: [] } },
      latencyMs: 1,
      outcome: 'data',
    });
    const eventKey = `recovery:${randomUUID()}`;
    const nextCheckAt = new Date(Date.now() + 5 * 60_000);

    await expect(
      __fixture.hub.finalizeRecovery(__fixture.tenantA, id, {
        expectedLifecycleVersion: 0,
        expectedSignalFence: serializeSignalFence([cleared.signal]),
        restoreInvestigationStatus: 'queued',
        verificationStartedAt: new Date(Date.now() - 1_000),
        eventKey,
        content: 'Latency is improving; check again.',
        summary: 'Latency remains elevated but is trending down.',
        outcome: 'recheck',
        attempt: 1,
        maxChecks: 3,
        recoveryEvidenceIds: [evidenceId],
        recoveryUnknowns: [],
        recoveryNextStep: 'Recheck checkout latency.',
        recoveryChecks: [{ name: 'Checkout latency', before: '2.1s', now: '800ms' }],
        assessedMaterials: [],
        scheduleRecheck: {
          nextCheckAt,
          reason: 'The deployment is still converging.',
          enqueueTx: async (tx) => {
            await tx.insert(jobs).values({
              tenantId: __fixture.tenantA,
              type: 'recovery.verify',
              payload: { incidentId: id, attempt: 2, maxChecks: 3 },
              status: 'queued',
              stream: 'sre:jobs',
              availableAt: nextCheckAt,
            });
            throw new Error('simulated scheduling failure');
          },
        },
      }),
    ).rejects.toThrow('simulated scheduling failure');

    expect(await getIncident(__fixture.app.db, __fixture.tenantA, id)).toMatchObject({
      recoveryState: null,
      recoveryAttempt: null,
      recoveryNextCheckAt: null,
    });
    expect(await __fixture.hub.appendedByOrigin(__fixture.tenantA, id, eventKey)).toBeNull();
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(sql`payload->>'incidentId' = ${id}`),
    ).toEqual([]);
  });

  test('append persists a summary and history reflects it', async () => {
    const runId = randomUUID();
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      kind: 'finding',
      content: 'a long detailed root-cause write-up that surfaces render in full',
      summary: 'DB connection pool exhausted',
      finding: {
        runId,
        outcome: 'conclusive',
        promotion: 'trusted_assessment',
        promotionReason: 'conclusive_assessment',
        evidenceIds: [],
        currentState: 'Errors elevated',
        impact: 'Checkout requests fail',
        nextStep: 'Inspect connection ownership',
      },
    });
    expect(m.summary).toBe('DB connection pool exhausted');
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.summary).toBe('DB connection pool exhausted');
    expect(hist.find((h) => h.id === m.id)?.finding).toMatchObject({
      runId,
      promotion: 'trusted_assessment',
    });
  });

  test('summary is null when omitted', async () => {
    const m = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'agent',
      content: 'no summary',
    });
    expect(m.summary ?? null).toBeNull();
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.find((h) => h.id === m.id)?.summary ?? null).toBeNull();
  });

  test('another tenant cannot read the conversation (RLS)', async () => {
    expect(await __fixture.hub.history(__fixture.tenantB, __fixture.incidentId)).toHaveLength(0);
  });

  test('subscribe delivers appended messages live', async () => {
    let resolveMsg!: (m: HubMessage) => void;
    const got = new Promise<HubMessage>((r) => {
      resolveMsg = r;
    });
    const unsubscribe = await __fixture.hub.subscribe(__fixture.incidentId, (m) => resolveMsg(m));
    const appended = await __fixture.hub.append(__fixture.tenantA, __fixture.incidentId, {
      author: 'human',
      kind: 'text',
      content: 'what about the DB?',
    });
    const delivered = await got;
    expect(delivered.id).toBe(appended.id);
    expect(delivered.content).toBe('what about the DB?');
    await unsubscribe();
  });

  // appendOnce is unique on (tenant_id, origin_message_id) — a redelivered inbound job re-appends
  // nothing. `inserted` is INFORMATION, never a gate on the fan-out.
  test('appendOnce is idempotent on originMessageId: one row, inserted:false on the redelivery', async () => {
    const origin = `slack:C-hub:${randomUUID()}`;
    const msg = {
      author: 'human' as const,
      kind: 'text' as const,
      content: 'still broken?',
      originSurface: 'slack',
      originMessageId: origin,
    };
    const first = await __fixture.hub.appendOnce(__fixture.tenantA, __fixture.incidentId, msg);
    const again = await __fixture.hub.appendOnce(__fixture.tenantA, __fixture.incidentId, msg);

    expect(first.inserted).toBe(true);
    expect(again.inserted).toBe(false);
    expect(again.message.id).toBe(first.message.id); // the SAME line, not a second one
    const hist = await __fixture.hub.history(__fixture.tenantA, __fixture.incidentId);
    expect(hist.filter((h) => h.id === first.message.id)).toHaveLength(1);
  });
});
