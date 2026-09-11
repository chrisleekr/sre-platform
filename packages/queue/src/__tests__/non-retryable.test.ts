import { expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { jobs } from '@sre/db';
import { NonRetryableError } from '../queue';
import { createFixture } from './queue.fixture';

const fixture = createFixture();

test('non-retryable failures are terminal on their first attempt, even on redelivery', async () => {
  const id = await fixture.q.enqueue({ tenantId: fixture.tenant, type: fixture.TYPE, payload: {} });
  const handle = vi.fn(async () => {
    throw new NonRetryableError('provider rate limit');
  });
  await fixture.q.process('worker', handle, { idleMs: 0 });
  await fixture.redis.xadd(fixture.STREAM, '*', 'jobId', id);
  await fixture.q.process('worker', handle, { idleMs: 0 });
  expect(handle).toHaveBeenCalledTimes(1);
  const [job] = await fixture.db.db.select().from(jobs).where(eq(jobs.id, id));
  expect(job).toMatchObject({ status: 'dead', attempts: 1, lastError: 'provider rate limit' });
  expect(await fixture.q.dispatchDue()).toBe(0);
});
