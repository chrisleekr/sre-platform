import { expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { getIncident, investigationRuns, jobs } from '@sre/db';
import { ProviderRateLimitError } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

test('rate-limited investigations stop after one attempt and retain a safe reason', async () => {
  const worker = fixture.workerWithEngine({
    provider: 'anthropic',
    async investigate() {
      throw new ProviderRateLimitError();
    },
    async resume() {
      throw new Error('not used');
    },
    async verifyRecovery() {
      throw new Error('not used');
    },
  });
  const id = await fixture.queue.enqueue({
    tenantId: fixture.tenantId,
    type: 'triage',
    payload: { incidentId: fixture.incidentId },
  });
  await worker.tick('rate-limit-test');
  const [job] = await fixture.admin.db.select().from(jobs).where(eq(jobs.id, id));
  expect(job).toMatchObject({
    status: 'dead',
    attempts: 1,
    lastError: 'AI provider rate limit reached',
  });
  expect(await fixture.queue.dispatchDue()).toBe(0);
  expect(await worker.tick('rate-limit-test')).toBe(0);
  const [run] = await fixture.admin.db
    .select()
    .from(investigationRuns)
    .where(eq(investigationRuns.jobId, id));
  expect(run).toMatchObject({
    outcome: 'failed',
    result: { summary: 'AI provider rate limit reached.' },
  });
  const history = await fixture.hub.history(fixture.tenantId, fixture.incidentId);
  expect(
    history.some((message) => message.summary?.includes('AI provider rate limit reached')),
  ).toBe(true);
  expect(history.some((message) => message.summary?.includes('engine error'))).toBe(false);
  expect(
    history.some((message) => message.summary?.includes('No automatic retry will be made')),
  ).toBe(true);
  expect((await getIncident(fixture.app.db, fixture.tenantId, fixture.incidentId))?.status).toBe(
    'open',
  );
});
