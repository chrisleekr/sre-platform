import { describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { INVESTIGATION_RETRY_ORIGIN_PREFIX } from '@sre/contracts';
import { createIncident, incidentMessages, incidents, investigationRuns, jobs } from '@sre/db';
import { createFixture } from '../../__tests__/incidents.fixture';
import { INVESTIGATION_RETRY_MESSAGE } from '../investigation-retry';

const __fixture = createFixture();

/**
 * `failed` mirrors what the worker persists for an engine failure with no prior assessment: a failed
 * run whose result carries only a summary, and the incident degraded.
 */
async function incidentWith(state: 'failed' | 'degraded' | 'conclusive') {
  const incident = await createIncident(__fixture.app.db, __fixture.tenantC, {
    fingerprint: `retry-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'retry-test',
    severity: 'sev3',
  });
  if (state !== 'degraded')
    await __fixture.admin.db.insert(investigationRuns).values({
      id: randomUUID(),
      tenantId: __fixture.tenantC,
      incidentId: incident.id,
      operation: 'investigate',
      outcome: state,
      result: { summary: state === 'failed' ? 'Engine execution failed.' : 'Pool saturation.' },
      completedAt: new Date(),
    });
  if (state !== 'conclusive')
    await __fixture.admin.db
      .update(incidents)
      .set({ investigationStatus: 'degraded' })
      .where(eq(incidents.id, incident.id));
  return incident.id;
}

async function retry(id: string, body: unknown, org = __fixture.orgC) {
  return __fixture.api.request(`/incidents/${id}/investigation/retry`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${await __fixture.sign(org)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function resumeJobs(id: string) {
  return __fixture.admin.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, 'resume'), eq(jobs.tenantId, __fixture.tenantC)))
    .then((rows) =>
      rows.filter((row) => (row.payload as { incidentId?: string }).incidentId === id),
    );
}

async function retryMessages(id: string) {
  return __fixture.admin.db
    .select()
    .from(incidentMessages)
    .where(
      and(
        eq(incidentMessages.incidentId, id),
        eq(incidentMessages.content, INVESTIGATION_RETRY_MESSAGE),
      ),
    );
}

describe('POST /incidents/:id/investigation/retry', () => {
  test('a failed investigation queues one resume from an attributed human message', async () => {
    const id = await incidentWith('failed');
    const requestId = randomUUID();

    const first = await retry(id, { requestId, expectedVersion: 0 });
    expect(first.status).toBe(200);
    const body = (await first.json()) as { outcome: string; messageId: string; replayed: boolean };
    expect(body).toMatchObject({ outcome: 'queued', replayed: false });

    const [message] = await retryMessages(id);
    expect(message).toMatchObject({
      id: body.messageId,
      author: 'human',
      originSurface: 'dashboard',
      authorUserId: __fixture.tenantCUserId,
      // The worker recognises the retry by this server-set prefix, never by the text.
      originMessageId: `${INVESTIGATION_RETRY_ORIGIN_PREFIX}${id}:${requestId}`,
    });
    const queued = await resumeJobs(id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      status: 'queued',
      payload: { incidentId: id, humanMessageId: body.messageId },
    });

    // An HTTP retry of the same request replays the first result instead of hitting the guard.
    const again = await retry(id, { requestId, expectedVersion: 0 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      outcome: 'queued',
      messageId: body.messageId,
      replayed: true,
    });
    expect(await resumeJobs(id)).toHaveLength(1);
    expect(await retryMessages(id)).toHaveLength(1);

    // A new request while that resume is pending is refused, so a double click cannot stack runs.
    const pending = await retry(id, { requestId: randomUUID(), expectedVersion: 0 });
    expect(pending.status).toBe(409);
    expect(await pending.json()).toEqual({ error: 'automation_pending' });
    expect(await resumeJobs(id)).toHaveLength(1);
  });

  test('a degraded investigation with no completed run is retryable', async () => {
    const id = await incidentWith('degraded');
    const response = await retry(id, { requestId: randomUUID(), expectedVersion: 0 });
    expect(response.status).toBe(200);
    expect(await resumeJobs(id)).toHaveLength(1);
  });

  test('refuses an incident whose attention is not an investigation failure', async () => {
    const id = await incidentWith('conclusive');
    const response = await retry(id, { requestId: randomUUID(), expectedVersion: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_retryable' });
    expect(await resumeJobs(id)).toHaveLength(0);
    expect(await retryMessages(id)).toHaveLength(0);
  });

  test('refuses a resolved incident even when its last run failed', async () => {
    const id = await incidentWith('failed');
    await __fixture.admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, id));
    const response = await retry(id, { requestId: randomUUID(), expectedVersion: 0 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'not_retryable' });
    expect(await resumeJobs(id)).toHaveLength(0);
  });

  test('an archived incident is not found and queues nothing', async () => {
    const id = await incidentWith('failed');
    await __fixture.admin.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(eq(incidents.id, id));
    const response = await retry(id, { requestId: randomUUID(), expectedVersion: 0 });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'incident not found' });
    expect(await resumeJobs(id)).toHaveLength(0);
    expect(await retryMessages(id)).toHaveLength(0);
  });

  test('refuses a stale lifecycle version', async () => {
    const id = await incidentWith('failed');
    const response = await retry(id, { requestId: randomUUID(), expectedVersion: 7 });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'stale' });
    expect(await resumeJobs(id)).toHaveLength(0);
  });

  test('another tenant cannot see or retry the incident', async () => {
    const id = await incidentWith('failed');
    const response = await retry(
      id,
      { requestId: randomUUID(), expectedVersion: 0 },
      __fixture.orgA,
    );
    expect(response.status).toBe(404);
    expect(await resumeJobs(id)).toHaveLength(0);
    expect(await retryMessages(id)).toHaveLength(0);
  });

  test('rejects a request without a request identity or version', async () => {
    const id = await incidentWith('failed');
    expect((await retry(id, { expectedVersion: 0 })).status).toBe(400);
    expect((await retry(id, { requestId: 'nope', expectedVersion: 0 })).status).toBe(400);
    expect((await retry(id, { requestId: randomUUID() })).status).toBe(400);
    expect((await retry(id, { requestId: randomUUID(), expectedVersion: -1 })).status).toBe(400);
    expect(await resumeJobs(id)).toHaveLength(0);
  });
});
