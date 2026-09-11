import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { jobs } from '@sre/db';
import { sql } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

// POST /incidents/:id/postmortem/generate is a durable command, not an LLM call. It enqueues a
// postmortem.generate job on the runbook stream, coalesces a double-click, and validates the trigger.
const __fixture = createFixture();

async function generate(id: string, token: string, body: unknown): Promise<Response> {
  const auth = __fixture.auth(token);
  return __fixture.api.request(`/incidents/${id}/postmortem/generate`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /incidents/:id/postmortem/generate', () => {
  test('enqueues a postmortem.generate job with the declared trigger and the requester, 202', async () => {
    const res = await generate(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgC), {
      trigger: 'user_visible_impact',
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobId).toBeTruthy();
    const rows = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`id = ${jobId}`);
    expect(rows[0]).toMatchObject({
      tenantId: __fixture.tenantC,
      type: 'postmortem.generate',
      stream: 'sre:runbook',
      status: 'queued',
      payload: {
        incidentId: __fixture.runbookIncidentId,
        trigger: 'user_visible_impact',
        requestedByUserId: __fixture.tenantCUserId,
      },
    });
  });

  test('a double-click coalesces onto the pending job: same jobId, one queued generation', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const first = await generate(__fixture.runbookIncidentId, token, { trigger: 'data_loss' });
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    const second = await generate(__fixture.runbookIncidentId, token, { trigger: 'data_loss' });
    expect(second.status).toBe(202);
    expect(((await second.json()) as { jobId: string }).jobId).toBe(jobId);
    const pending = await __fixture.admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        sql`type = 'postmortem.generate' and payload->>'incidentId' = ${__fixture.runbookIncidentId} and status in ('queued','processing')`,
      );
    expect(pending).toHaveLength(1);
  });

  test('an unknown or missing trigger is a 400 with no durable job', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    expect(
      (await generate(__fixture.postmortemIncidentId, token, { trigger: 'because' })).status,
    ).toBe(400);
    expect((await generate(__fixture.postmortemIncidentId, token, {})).status).toBe(400);
    expect(
      await __fixture.admin.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          sql`type = 'postmortem.generate' and payload->>'incidentId' = ${__fixture.postmortemIncidentId}`,
        ),
    ).toEqual([]);
  });

  test('a non-UUID, a missing incident, or another tenant is a 404', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    expect((await generate('not-a-uuid', token, { trigger: 'data_loss' })).status).toBe(404);
    expect((await generate(randomUUID(), token, { trigger: 'data_loss' })).status).toBe(404);
    expect(
      (
        await generate(__fixture.runbookIncidentId, await __fixture.sign(__fixture.orgA), {
          trigger: 'data_loss',
        })
      ).status,
    ).toBe(404);
  });

  test('GET /incidents/:id/postmortem is 404 until a draft exists', async () => {
    const res = await __fixture.api.request(
      `/incidents/${__fixture.postmortemIncidentId}/postmortem`,
      __fixture.auth(await __fixture.sign(__fixture.orgC)),
    );
    expect(res.status).toBe(404);
  });
});
