import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { createIncident, getIncident, jobs } from '@sre/db';
import { sql } from 'drizzle-orm';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import type { ResumeInput, TriageResult } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

test.each(['Yes', 'No'] as const)(
  'keeps diagnostic %s without a capture offer as read-only investigation input',
  async (answer) => {
    const { id: incidentId } = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      service: 'node',
      severity: 'sev3',
      alertSource: 'slack',
    });
    await fixture.hub.append(fixture.tenantId, incidentId, {
      author: 'human',
      authorUserId: fixture.actorUserId,
      content: 'Check the runner disk metrics.',
    });
    await fixture.hub.append(fixture.tenantId, incidentId, {
      author: 'agent',
      kind: 'reply',
      content: 'Did the runner start again at 10:56?',
    });
    const human = await fixture.hub.append(fixture.tenantId, incidentId, {
      author: 'human',
      authorUserId: fixture.actorUserId,
      content: answer,
    });
    const classify = vi.fn((prompt: string) => ({
      kind:
        JSON.parse(prompt).currentResponderMessage === answer ? 'capture_knowledge' : 'investigate',
      target: 'current',
      to: null,
      reason: 'Scripted intent.',
    }));
    const resume = vi.fn(async (_input: ResumeInput): Promise<TriageResult> => ({
      provider: 'fake',
      sessionId: 'diagnostic-answer',
      outcome: 'conclusive',
      disposition: 'reply',
      summary: 'Checking the matching observation window.',
      detail: 'Your answer is additional diagnostic context, not permission to save anything.',
      turnBudget: 1,
      confidence: 0,
    }));
    const worker = fixture.workerWithEngine(
      { ...makeFakeEngine(), resume },
      { generator: makeFakeGenerator(classify), runbookQueue: fixture.queue },
    );
    await worker.handle(
      {
        id: randomUUID(),
        tenantId: fixture.tenantId,
        type: 'resume',
        attempts: 1,
        payload: { incidentId, humanMessageId: human.id },
      },
      { signal: new AbortController().signal },
    );

    expect(resume).toHaveBeenCalledTimes(1);
    const input = resume.mock.calls[0]![0];
    expect(input.humanMessage).toContain(answer);
    expect(JSON.stringify(input)).toContain('Check the runner disk metrics.');
    expect(JSON.stringify(input)).toContain('Did the runner start again at 10:56?');
    expect(
      classify.mock.calls.every(
        ([prompt]) => JSON.parse(prompt).currentResponderMessage !== answer,
      ),
    ).toBe(true);
    const history = await fixture.hub.history(fixture.tenantId, incidentId);
    expect(history.some((message) => message.originMessageId?.startsWith('knowledge-'))).toBe(
      false,
    );
    expect(
      await fixture.admin.db
        .select()
        .from(jobs)
        .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incidentId}`),
    ).toHaveLength(0);
    expect(await getIncident(fixture.app.db, fixture.tenantId, incidentId)).toMatchObject({
      status: 'open',
      rcaSummary: null,
      lastResumeMessageId: human.id,
    });
  },
);
