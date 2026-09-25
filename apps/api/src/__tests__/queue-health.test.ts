import { describe, expect, test } from 'vitest';
import { jobs } from '@sre/db';
import type { DeadJobPage, QueueHealth } from '@sre/contracts';
import { createFixture } from './incidents.fixture';

// The work-queue read model over HTTP. jobs sits outside RLS, so the route relies on the repo's
// explicit tenant filter; these cases pin it end to end with a verified token per tenant.
const fx = createFixture();

async function get(path: string, org: string) {
  return fx.api.request(path, fx.auth(await fx.sign(org)));
}

describe('GET /queue', () => {
  test('refuses a request without a verified identity', async () => {
    expect((await fx.api.request('/queue/health')).status).toBe(401);
    expect((await fx.api.request('/queue/dead')).status).toBe(401);
  });

  test('reports only the caller tenant, and pages dead jobs by cursor', async () => {
    const type = `queue-route-${crypto.randomUUID().slice(0, 8)}`;
    await fx.admin.db.insert(jobs).values([
      { tenantId: fx.tenantA, type, stream: 'test', status: 'dead', lastError: 'first' },
      { tenantId: fx.tenantA, type, stream: 'test', status: 'dead', lastError: 'second' },
      { tenantId: fx.tenantA, type, stream: 'test', status: 'queued' },
      { tenantId: fx.tenantB, type, stream: 'test', status: 'dead' },
      { tenantId: fx.tenantB, type, stream: 'test', status: 'queued' },
    ]);

    const healthA = (await (await get('/queue/health', fx.orgA)).json()) as QueueHealth;
    expect(healthA.types.find((row) => row.type === type)).toMatchObject({
      queued: 1,
      processing: 0,
      dead: 2,
    });
    const healthB = (await (await get('/queue/health', fx.orgB)).json()) as QueueHealth;
    expect(healthB.types.find((row) => row.type === type)).toMatchObject({ queued: 1, dead: 1 });

    const first = await get('/queue/dead?limit=1', fx.orgA);
    expect(first.status).toBe(200);
    const pageOne = (await first.json()) as DeadJobPage;
    expect(pageOne.jobs).toHaveLength(1);
    expect(pageOne.nextCursor).toEqual(expect.any(String));
    const pageTwo = (await (
      await get(`/queue/dead?limit=1&cursor=${pageOne.nextCursor}`, fx.orgA)
    ).json()) as DeadJobPage;
    const seen = [...pageOne.jobs, ...pageTwo.jobs].filter((job) => job.type === type);
    expect(seen.map((job) => job.lastError).sort()).toEqual(['first', 'second']);

    const deadB = (await (await get('/queue/dead', fx.orgB)).json()) as DeadJobPage;
    expect(deadB.jobs.filter((job) => job.type === type)).toHaveLength(1);
    expect(deadB.jobs.some((job) => job.lastError === 'first')).toBe(false);
  });

  test('rejects a malformed cursor and an out-of-range limit', async () => {
    expect((await get('/queue/dead?cursor=not-a-cursor', fx.orgA)).status).toBe(400);
    expect((await get('/queue/dead?limit=0', fx.orgA)).status).toBe(400);
    expect((await get('/queue/dead?limit=51', fx.orgA)).status).toBe(400);
  });
});
