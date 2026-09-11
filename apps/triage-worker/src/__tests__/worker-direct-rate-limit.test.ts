import { afterEach, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createIncident, jobs } from '@sre/db';
import { makeClaudeEngine } from '../engine/claude';
import { makeOpenAIEngine } from '../engine/openai';
import { createFixture } from './worker.fixture';

const fixture = createFixture();
afterEach(() => vi.unstubAllGlobals());

test.each(['anthropic', 'openai'] as const)(
  '%s SDK and worker make only one request on HTTP 429',
  async (provider) => {
    const fetch = vi.fn(async () =>
      Response.json(
        {
          error: {
            type: 'rate_limit_error',
            message: 'Rate limit exceeded',
          },
        },
        { status: 429, headers: { 'x-should-retry': 'true', 'retry-after': '1' } },
      ),
    );
    vi.stubGlobal('fetch', fetch);
    const engine =
      provider === 'anthropic'
        ? makeClaudeEngine({ apiKey: 'test-key', model: 'test-model' })
        : makeOpenAIEngine({ apiKey: 'test-key', model: 'test-model' });
    const { id: incidentId } = await createIncident(fixture.app.db, fixture.tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'manual',
      service: 'checkout',
      severity: 'sev3',
    });
    const id = await fixture.queue.enqueue({
      tenantId: fixture.tenantId,
      type: 'triage',
      payload: { incidentId },
    });
    await fixture.workerWithEngine(engine).tick('direct-rate-limit');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [job] = await fixture.admin.db.select().from(jobs).where(eq(jobs.id, id));
    expect(job).toMatchObject({
      status: 'dead',
      attempts: 1,
      lastError: 'AI provider rate limit reached',
    });
  },
);
