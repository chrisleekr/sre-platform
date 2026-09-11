import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { approvals, createIncident, decideApproval, incidents, withTenant } from '@sre/db';

import { makeDbAuditSink, scrubSecrets } from '@sre/agent-tools';

import { approvalActionId } from '../engine/approval-id';

import { TriageWorker } from '../worker';

import {
  type ResumeInput,
  type TriageEngine,
  type TriageInput,
  type TriageResult,
} from '../engine/types';

import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker', () => {
  // Build a worker with a capturing engine (records the first-turn TriageInput) and an injected
  // runbookSeeder. `runbookSeeder` is not yet on TriageWorkerDeps, so cast — RED until the worker
  // both accepts and consumes it.

  test('a Recommended Action retains exact post-scrub content in its row and linked Hub message', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const secret = 'sk-abcdefghijklmnopqrstuvwx1234';
    const rawPrompt =
      `Recommended Action (L3)\n\nRotate the exposed checkout credential.\n\n` +
      `Command or rollback reference:\nkubectl set env deployment/checkout API_KEY=${secret}`;
    const rawOptions = [
      { id: 'approve', label: `Approve with key ${secret}` },
      { id: 'deny', label: 'Deny' },
    ];
    const prompt = scrubSecrets(rawPrompt);
    const options = rawOptions.map((option) => ({
      ...option,
      label: scrubSecrets(option.label),
    }));
    const secretEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'approval',
          summary: rawPrompt,
          confidence: 0,
          approval: {
            prompt: rawPrompt,
            options: rawOptions,
          },
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
    const secretWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: secretEngine,
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
    expect(await secretWorker.tick('appr-c1c')).toBe(1);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.prompt).toBe(prompt);
    expect(rows[0]!.options).toEqual(options);
    expect(rows[0]!.actionId).toBe(approvalActionId(prompt, options));
    expect(rows[0]!.prompt).not.toContain(secret);
    expect(rows[0]!.prompt).toContain('[REDACTED]');
    expect((rows[0]!.options as typeof options)[0]!.label).not.toContain(secret);

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const appr = history.find((m) => m.kind === 'approval');
    expect(appr).toMatchObject({
      content: prompt,
      approvalId: rows[0]!.id,
      approval: { id: rows[0]!.id, options },
    });
    expect(appr!.content).not.toContain(secret);
  });

  // RED: the persisted action_id must hash the POST-scrub prompt/labels, not the raw ones. The engines
  // compute approvalActionId on what the MODEL proposed (pre-scrub, engine/approval-id.ts), and the worker
  // persists that id verbatim while scrubbing the prompt+labels into the row — so the durable idempotency
  // key encodes the secret's pre-scrub shape and no longer matches the content the row actually holds. The
  // key must be derived from the scrubbed content, so it can be reproduced from the persisted row and never
  // carries the raw secret's fingerprint.
  test('the approvals row action_id hashes the SCRUBBED prompt/labels, not the raw ones', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    // A scrub-removable secret (sk-… OpenAI-style key, redact.ts SECRET_PATTERNS) in BOTH the prompt and an
    // option label, so scrubbing changes the hash preimage.
    const rawPrompt = 'Rotate the leaked key sk-abcdefghijklmnopqrstuvwx1234 and restart?';
    const rawOptions = [{ id: 'approve', label: 'Approve with sk-abcdefghijklmnopqrstuvwx1234' }];
    // What both engines actually do: hash the PRE-scrub proposal.
    const rawActionId = approvalActionId(rawPrompt, rawOptions);
    const secretEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'approval',
          summary: 'Restart?',
          confidence: 0,
          approval: { prompt: rawPrompt, options: rawOptions },
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
    const secretWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: secretEngine,
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
    expect(await secretWorker.tick('appr-207')).toBe(1);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(1);

    // The stored key must address the SCRUBBED content the row holds (reproducible from that row on a
    // redelivery), not the raw proposal's fingerprint. Fresh incident + triage path => first insert, no salt.
    const scrubbedPrompt = scrubSecrets(rawPrompt);
    const scrubbedOptions = rawOptions.map((o) => ({ ...o, label: scrubSecrets(o.label) }));
    expect(rows[0]!.actionId).toBe(approvalActionId(scrubbedPrompt, scrubbedOptions));
    expect(rows[0]!.actionId).not.toBe(rawActionId);
  });

  // The engine re-proposes the SAME action (identical prompt+options) on a later resume —
  // exactly what a redelivered turn produces once actionId is a content hash. createApproval collapses
  // the row, but persistDisposition appends the kind='approval' hub message UNCONDITIONALLY, so the
  // human sees TWO button blocks for one action and only one of them can ever be decided.
  // RED today: two 'approval' messages. The append must be conditional on a genuine insert.
  test('/C10 a re-proposed approval yields ONE approvals row and ONE approval hub message', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const prompt = 'Restart checkout?';
    const options = [{ id: 'approve', label: 'Approve' }];
    // Whatever the human says, the engine proposes the SAME action, so the worker derives the identical
    // content-hash key on each resume and the (tenant, incident, action_id) upsert collapses the second.
    const repeatEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 'checkout pods wedged',
          confidence: 60,
        };
      },
      async resume(input: ResumeInput): Promise<TriageResult> {
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
    };
    const repeatWorker = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: repeatEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    const first = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'what now?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: first.id },
    });
    expect(await repeatWorker.tick('appr-dup-1')).toBe(1);

    // A second human reply (past the resume watermark, so the run is not pre-gated) draws the SAME
    // proposal again — the redelivery shape the approvals key is designed to absorb.
    const second = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'still stuck?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: second.id },
    });
    expect(await repeatWorker.tick('appr-dup-2')).toBe(1);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(1); // the (tenant, incident, action_id) upsert collapsed the second

    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    const approvalMsgs = history.filter((m) => m.kind === 'approval');
    // Exactly ONE button block: a second one would point at the same row, and whichever the human did
    // not tap would sit un-decidable forever.
    expect(approvalMsgs).toHaveLength(1);
    expect(approvalMsgs[0]!.approvalId).toBe(rows[0]!.id);
  });

  // consent is SPENT once a human decides. A content-hash key alone cannot tell "the same
  // proposal, redelivered" from "the same action, proposed again after it was DENIED" — and collapsing the
  // latter onto the decided row posts no buttons at all, leaving the engine waiting on a decision no human
  // will ever be shown. A decided row is therefore re-keyed on the TURN (the newest drained human reply),
  // which is stable across a redelivery of that turn and distinct across a new one.
  test('a re-proposal AFTER the approval was decided gets its OWN row and its OWN button block', async () => {
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
    const actionId = approvalActionId(prompt, options);
    const proposeEngine: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 'checkout pods wedged',
          confidence: 60,
        };
      },
      // The engine keeps proposing the identical action: the content hash is the same every turn.
      async resume(input: ResumeInput): Promise<TriageResult> {
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
    };
    const w = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: proposeEngine,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    // Turn 1: the engine proposes; one row, one button block.
    const first = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'what now?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: first.id },
    });
    expect(await w.tick('appr-dec-1')).toBe(1);

    // The human DENIES it. Consent is now spent for that row.
    expect(
      await decideApproval(
        __fixture.app.db,
        __fixture.tenantId,
        incId,
        actionId,
        'deny',
        'u-human',
      ),
    ).toBe(true);

    // Turn 2: remediation is still needed, so the engine proposes the identical action again.
    const second = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'try again',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: second.id },
    });
    expect(await w.tick('appr-dec-2')).toBe(1);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    // TWO rows: the decided one, and a fresh undecided one the human can actually act on.
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.decision === null)).toHaveLength(1);
    const history = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(history.filter((m) => m.kind === 'approval')).toHaveLength(2);

    // ...and that SECOND turn, REDELIVERED, is still idempotent: the salt is the TURN, not a nonce.
    // The redelivery must actually REACH the approval branch, so rewind the watermark: this is the real
    // crash window (between the approval insert and advanceResumeWatermark, both inside that branch). With
    // the watermark already stamped, the exactly-once pre-gate returns before createApproval is ever
    // called and the test would prove nothing — a nonce salt would sail through it.
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.update(incidents).set({ lastResumeMessageId: first.id }).where(eq(incidents.id, incId)),
    );
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: second.id },
    });
    expect(await w.tick('appr-dec-3')).toBe(1);

    const after = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(after).toHaveLength(2); // no third row: the re-walked chain landed on the same salted row
    const historyAfter = await __fixture.hub.history(__fixture.tenantId, incId);
    expect(historyAfter.filter((m) => m.kind === 'approval')).toHaveLength(2); // no third block
  });

  // 5: the SALTED retry hashes post-scrub content too, not just the first insert. A secret in the
  // prompt/label rides through the spent-consent re-proposal path; both the first (unsalted) row and the
  // fresh salted row must key on the SCRUBBED proposal, never the raw one.
  test('the salted re-proposal row keys on the SCRUBBED prompt/labels (not the raw ones)', async () => {
    const { id: incId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
    });
    const rawPrompt = 'Rotate the leaked key sk-abcdefghijklmnopqrstuvwx1234 and restart?';
    const rawOptions = [{ id: 'approve', label: 'Approve with sk-abcdefghijklmnopqrstuvwx1234' }];
    const scrubbedPrompt = scrubSecrets(rawPrompt);
    const scrubbedOptions = rawOptions.map((o) => ({ ...o, label: scrubSecrets(o.label) }));
    const secretProposer: TriageEngine = {
      provider: 'fake',
      verifyRecovery: __fixture.verifyRecovery,
      async investigate(input: TriageInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          summary: 'checkout pods wedged',
          confidence: 60,
        };
      },
      async resume(input: ResumeInput): Promise<TriageResult> {
        return {
          provider: 'fake',
          sessionId: `fake:${input.incident.id}`,
          model: 'fake',
          outcome: 'conclusive',
          turnBudget: 1,
          disposition: 'approval',
          summary: rawPrompt,
          confidence: 0,
          approval: { prompt: rawPrompt, options: rawOptions },
        } as unknown as TriageResult;
      },
    };
    const w = new TriageWorker({
      generator: __fixture.responderGenerator(),
      appDb: __fixture.app.db,
      hub: __fixture.hub,
      engine: secretProposer,
      queue: __fixture.queue,
      auditSink: makeDbAuditSink({ db: __fixture.app.db }),
      connectorProvider: __fixture.connectorProvider,
      tools: __fixture.tools,
      lock: __fixture.engineLock,
      clearResumeGate: async () => {},
    });

    // Turn 1: first (unsalted) insert keys on the scrubbed content.
    const first = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'what now?',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: first.id },
    });
    expect(await w.tick('appr-207salt-1')).toBe(1);
    const firstActionId = approvalActionId(scrubbedPrompt, scrubbedOptions);
    expect(
      await decideApproval(
        __fixture.app.db,
        __fixture.tenantId,
        incId,
        firstActionId,
        'deny',
        'u-human',
      ),
    ).toBe(true);

    // Turn 2: spent consent forces the salted chain (attempt 1, base = the resume's humanMessageId).
    const second = await __fixture.hub.append(__fixture.tenantId, incId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'try again',
    });
    await __fixture.queue.enqueue({
      tenantId: __fixture.tenantId,
      type: 'resume',
      payload: { incidentId: incId, humanMessageId: second.id },
    });
    expect(await w.tick('appr-207salt-2')).toBe(1);

    const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(approvals).where(eq(approvals.incidentId, incId)),
    );
    expect(rows).toHaveLength(2);
    const salted = rows.find((r) => r.decision === null)!;
    // The salted key is the SCRUBBED proposal + the turn salt, never the raw preimage.
    expect(salted.actionId).toBe(
      approvalActionId(scrubbedPrompt, scrubbedOptions, `${second.id}#1`),
    );
    expect(salted.actionId).not.toBe(approvalActionId(rawPrompt, rawOptions, `${second.id}#1`));
    // And the durable row carries the scrubbed label, never the secret.
    const storedLabel = (salted.options as { id: string; label: string }[])[0]!.label;
    expect(storedLabel).not.toContain('sk-abcdefghijklmnopqrstuvwx1234');
  });
});
