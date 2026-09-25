import { expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '@sre/db';
import { ProviderConfigurationError } from '../engine/types';
import { createFixture } from './worker.fixture';

const fixture = createFixture();

// A rejected model or credential fails the same way on every attempt, so redelivery only burns them.
test('a provider configuration rejection stops the investigation after one attempt', async () => {
  const worker = fixture.workerWithEngine({
    provider: 'anthropic',
    async investigate() {
      throw new ProviderConfigurationError(401);
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
  await worker.tick('provider-configuration-test');
  const [job] = await fixture.admin.db.select().from(jobs).where(eq(jobs.id, id));
  expect(job).toMatchObject({
    status: 'dead',
    attempts: 1,
    lastError: 'AI provider rejected the configured request (status 401)',
  });
  expect(await fixture.queue.dispatchDue()).toBe(0);
  expect(await worker.tick('provider-configuration-test')).toBe(0);
});
