import { describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  applyTriageResult,
  createIncident,
  getIncident,
  recordSurfaceBinding,
  surfaceDeliveries,
  upsertSurfaceConfig,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { makeSlackPoster } from '@sre/surfaces';
import { createFixture as createSlackFixture } from '../../../../packages/surfaces/src/__tests__/slack.fixture';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import { reviewedEngine } from '../engine/evidence-review';
import type { TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const __fixture = createFixture();

describe('TriageWorker resume dispositions', () => {
  test('publishes the reviewer-corrected long answer through the real review and persistence boundaries', async () => {
    const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: randomUUID(),
      service: 'node',
      severity: 'sev3',
      alertSource: 'slack',
    });
    await upsertSurfaceConfig(__fixture.app.db, __fixture.tenantId, { surface: 'slack' });
    await recordSurfaceBinding(__fixture.app.db, __fixture.tenantId, {
      incidentId,
      surface: 'slack',
      channel: 'C-REVIEW',
      threadId: '1.1',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incidentId, {
      provider: 'fake',
      sessionId: 'accepted',
      summary: 'Prior trusted assessment.',
      confidence: 75,
    });
    const human = await __fixture.hub.append(__fixture.tenantId, incidentId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Give me the complete diagnostic guide.',
    });
    const detail = `# Corrected diagnostic guide\n${'Compare equivalent observation windows before attributing load.\n'.repeat(130)}No remediation has been verified.`;
    const review = vi.fn(() => ({
      supported: false,
      summary: 'Diagnostic guide ready; no verified remedy.',
      detail,
      reason: 'The proposed restart is unsupported.',
      evidenceIds: [],
    }));
    const base = {
      ...makeFakeEngine(),
      resume: async (): Promise<TriageResult> => ({
        provider: 'fake',
        sessionId: 'draft',
        disposition: 'reply',
        outcome: 'conclusive',
        summary: 'Restarting every node fixes it.',
        detail: 'UNSUPPORTED-ORIGINAL: restart every production node.',
        turnBudget: 1,
        confidence: 95,
      }),
    };
    const worker = __fixture.workerWithEngine(reviewedEngine(base, makeFakeGenerator(review)));
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'resume' as const,
      attempts: 1,
      payload: { incidentId, humanMessageId: human.id },
    };
    await worker.handle(job, { signal: new AbortController().signal });
    await worker.handle(job, { signal: new AbortController().signal });

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    expect(detail.length).toBeGreaterThan(8_000);
    expect(history.filter((message) => message.content === detail)).toHaveLength(1);
    expect(history).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        content: detail,
        summary: 'Diagnostic guide ready; no verified remedy.',
        finding: expect.objectContaining({
          outcome: 'inconclusive',
          promotion: 'conversation_only',
        }),
        originMessageId: expect.stringMatching(/^run-result:/),
      }),
    );
    expect(history.some((message) => message.content.includes('UNSUPPORTED-ORIGINAL'))).toBe(false);
    expect(review).toHaveBeenCalledTimes(1);
    const reply = history.find((message) => message.content === detail)!;
    expect(
      await __fixture.admin.db
        .select()
        .from(surfaceDeliveries)
        .where(eq(surfaceDeliveries.messageId, reply.id)),
    ).toMatchObject([{ messageId: reply.id, surface: 'slack', state: 'queued' }]);
    const { fetch, calls } = createSlackFixture().fakeFetch({ ok: true, ts: '1.2' });
    const link = `https://sre.example.com/w/incidents/${incidentId}`;
    await makeSlackPoster(fetch).post(
      { token: 'fake-test-token', channel: 'C-REVIEW' },
      '1.1',
      reply,
      link,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.text).toContain('Diagnostic guide ready; no verified remedy.');
    expect(calls[0]!.body.text).toContain(link);
    expect(calls[0]!.body.text).not.toContain('Compare equivalent observation windows');
    expect(calls[0]!.body.text).not.toContain('UNSUPPORTED-ORIGINAL');
    expect(String(calls[0]!.body.text).length).toBeLessThan(1_000);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
      rcaSummary: 'Prior trusted assessment.',
      lastResumeMessageId: human.id,
    });
  });
  test('publishes the full corrected inconclusive reply once without replacing trusted RCA', async () => {
    const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    await applyTriageResult(__fixture.app.db, __fixture.tenantId, incidentId, {
      provider: 'fake',
      sessionId: 'prior',
      summary: 'Previously accepted RCA',
      confidence: 70,
    });
    const human = await __fixture.hub.append(__fixture.tenantId, incidentId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'How can we improve the diagnostic metrics?',
    });
    const detail = `# Diagnostic guide\n${'Compare the same observation window.\n'.repeat(240)}No verified root cause.`;
    const resume = vi.fn(async (): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: 'corrected',
      outcome: 'inconclusive',
      disposition: 'reply',
      turnBudget: 1,
      summary: 'Diagnostic guidance is available; the cause is not verified.',
      detail,
      confidence: 0,
      evidenceReceipts: [],
    }));
    const worker = __fixture.workerWithEngine({ ...makeFakeEngine(), resume });
    const job = {
      id: randomUUID(),
      tenantId: __fixture.tenantId,
      type: 'resume' as const,
      attempts: 1,
      payload: { incidentId, humanMessageId: human.id },
    };

    await worker.handle(job, { signal: new AbortController().signal });
    await worker.handle(job, { signal: new AbortController().signal });

    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    const replies = history.filter((message) => message.content === detail);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      kind: 'reply',
      summary: 'Diagnostic guidance is available; the cause is not verified.',
    });
    expect(history.some((message) => message.kind === 'finding')).toBe(false);
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
      rcaSummary: 'Previously accepted RCA',
      lastResumeMessageId: human.id,
    });
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test('withholds an inconclusive reply when newer human context arrives during the run', async () => {
    const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev3',
    });
    const human = await __fixture.hub.append(__fixture.tenantId, incidentId, {
      author: 'human',
      authorUserId: __fixture.actorUserId,
      content: 'Write a diagnostic guide.',
    });
    const worker = __fixture.workerWithEngine({
      ...makeFakeEngine(),
      resume: async (): Promise<TriageResult> => {
        await __fixture.hub.append(__fixture.tenantId, incidentId, {
          author: 'human',
          authorUserId: __fixture.actorUserId,
          content: 'Correction: the runner is now active.',
        });
        return {
          provider: 'fake',
          sessionId: 'stale',
          outcome: 'inconclusive',
          disposition: 'reply',
          turnBudget: 1,
          summary: 'Earlier draft',
          detail: 'STALE-DIAGNOSTIC-DETAIL',
          confidence: 0,
        };
      },
    });
    await worker.handle(
      {
        id: randomUUID(),
        tenantId: __fixture.tenantId,
        type: 'resume',
        attempts: 1,
        payload: { incidentId, humanMessageId: human.id },
      },
      { signal: new AbortController().signal },
    );
    const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
    expect(history.some((message) => message.content.includes('STALE-DIAGNOSTIC-DETAIL'))).toBe(
      false,
    );
    expect(history).toContainEqual(
      expect.objectContaining({
        finding: expect.objectContaining({ promotion: 'not_promoted', outcome: 'inconclusive' }),
        content: expect.stringContaining('New responder context'),
      }),
    );
    expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
      rcaSummary: null,
      status: 'open',
    });
  });

  test.each([
    ['failed', 'reply'],
    ['budget_exhausted', 'reply'],
    ['inconclusive', 'approval'],
    ['inconclusive', 'recovery'],
  ] as const)(
    'does not publish actionable detail for %s %s results',
    async (outcome, disposition) => {
      const { id: incidentId } = await createIncident(__fixture.app.db, __fixture.tenantId, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'checkout',
        severity: 'sev3',
      });
      const human = await __fixture.hub.append(__fixture.tenantId, incidentId, {
        author: 'human',
        authorUserId: __fixture.actorUserId,
        content: 'What should we check?',
      });
      const worker = __fixture.workerWithEngine({
        ...makeFakeEngine(),
        resume: async (): Promise<TriageResult> => ({
          provider: 'fake',
          sessionId: 'unsafe',
          outcome,
          disposition,
          turnBudget: 1,
          summary: 'The assessment is not verified.',
          detail: 'UNCHECKED-PROCEDURE',
          confidence: 0,
          approval: {
            prompt: 'Restart every node?',
            options: [{ id: 'approve', label: 'Approve' }],
          },
        }),
      });
      await worker.handle(
        {
          id: randomUUID(),
          tenantId: __fixture.tenantId,
          type: 'resume',
          attempts: 1,
          payload: { incidentId, humanMessageId: human.id },
        },
        { signal: new AbortController().signal },
      );
      const history = await __fixture.hub.history(__fixture.tenantId, incidentId);
      expect(
        history.some(
          (message) =>
            message.kind === 'approval' || message.content.includes('UNCHECKED-PROCEDURE'),
        ),
      ).toBe(false);
      expect(await getIncident(__fixture.app.db, __fixture.tenantId, incidentId)).toMatchObject({
        status: 'open',
        rcaSummary: null,
      });
    },
  );
});
