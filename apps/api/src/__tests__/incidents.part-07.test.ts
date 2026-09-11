import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { incidentMessages, incidentSignals, incidents, investigationSubjects, jobs } from '@sre/db';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('POST /incidents', () => {
  const body = (requestId = randomUUID()) => ({
    requestId,
    title: 'Checkout latency increased',
    description: 'Latency rose immediately after the latest deployment.',
    service: 'checkout-api',
    severity: 'sev3',
  });
  const durableManualCounts = async (tenantId: string) => {
    const [incidentRows, openerRows, jobRows] = await Promise.all([
      __fixture.admin.db
        .select({ count: sql<number>`count(*)::int` })
        .from(incidents)
        .where(and(eq(incidents.tenantId, tenantId), eq(incidents.alertSource, 'manual'))),
      __fixture.admin.db
        .select({ count: sql<number>`count(*)::int` })
        .from(incidentMessages)
        .where(
          and(
            eq(incidentMessages.tenantId, tenantId),
            sql`${incidentMessages.originMessageId} like 'dashboard:manual:%'`,
          ),
        ),
      __fixture.admin.db
        .select({ count: sql<number>`count(*)::int` })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenantId), eq(jobs.type, 'triage'))),
    ]);
    return {
      incidents: incidentRows[0]!.count,
      openers: openerRows[0]!.count,
      jobs: jobRows[0]!.count,
    };
  };

  test('requires authentication', async () => {
    const response = await __fixture.api.request('/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    });

    expect(response.status).toBe(401);
  });

  test('atomically creates one attributed workspace and one triage job, then reuses it on retry', async () => {
    const request = body();
    const token = await __fixture.sign(__fixture.orgC);
    const post = () =>
      __fixture.api.request('/incidents', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });

    const created = await post();
    expect(created.status).toBe(201);
    const result = (await created.json()) as { outcome: string; incidentId: string };
    expect(result).toEqual({ outcome: 'created', incidentId: expect.any(String) });

    const retried = await post();
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ outcome: 'existing', incidentId: result.incidentId });

    const [incidentRows, messageRows, jobRows, signalRows, subjectRows] = await Promise.all([
      __fixture.admin.db.select().from(incidents).where(eq(incidents.id, result.incidentId)),
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, result.incidentId)),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(sql`type = 'triage' and payload->>'incidentId' = ${result.incidentId}`),
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, result.incidentId)),
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(eq(investigationSubjects.incidentId, result.incidentId)),
    ]);
    expect(incidentRows).toHaveLength(1);
    expect(incidentRows[0]).toMatchObject({
      alertSource: 'manual',
      title: request.title,
      service: request.service,
      severity: request.severity,
    });
    expect(messageRows).toHaveLength(2);
    expect(messageRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          author: 'human',
          content: request.description,
          originSurface: 'dashboard',
          authorUserId: __fixture.tenantCUserId,
          originMessageId: `dashboard:manual:${request.requestId}`,
        }),
        expect.objectContaining({
          author: 'system',
          kind: 'lifecycle',
          lifecycleTo: 'open',
        }),
      ]),
    );
    expect(jobRows).toHaveLength(1);
    expect(jobRows[0]).toMatchObject({ type: 'triage', status: 'queued' });
    expect(jobRows[0]!.payload).toMatchObject({
      incidentId: result.incidentId,
      title: request.title,
      alert: {
        kind: 'human_report',
        description: request.description,
        reportedAt: expect.any(String),
      },
    });
    expect(signalRows).toHaveLength(0);
    expect(subjectRows).toHaveLength(0);

    const detail = await __fixture.api.request(
      `/incidents/${result.incidentId}`,
      __fixture.auth(token),
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      alertSource: 'manual',
      requiresHumanAttention: false,
      attentionReason: null,
    });
  });

  test('rejects malformed and oversized reports without creating a triage job', async () => {
    const token = await __fixture.sign(__fixture.orgC);
    const before = await __fixture.admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.tenantId, __fixture.tenantC));
    const invalid = [
      { ...body(), severity: 'warning' },
      { ...body(), description: ' ' },
      { ...body(), service: 'x'.repeat(201) },
      { ...body(), extra: 'browser evidence' },
    ];
    for (const value of invalid) {
      const response = await __fixture.api.request('/incidents', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });
      expect(response.status).toBe(400);
    }
    const oversized = await __fixture.api.request('/incidents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': String(32 * 1024 + 1),
      },
      body: '{}',
    });
    expect(oversized.status).toBe(413);
    const after = await __fixture.admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.tenantId, __fixture.tenantC));
    expect(after).toHaveLength(before.length);
  });

  test('accepts the documented character limit for a multibyte report', async () => {
    const response = await __fixture.api.request('/incidents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...body(), description: '診'.repeat(4_000) }),
    });

    expect(response.status).toBe(201);
  });

  test('scrubs secrets before storing or logging the human report', async () => {
    __fixture.apiLog.info.mockClear();
    const secret = 'glpat-ABCDEF1234567890abcd';
    const request = {
      ...body(),
      description: `The failing request used ${secret}`,
    };
    const response = await __fixture.api.request('/incidents', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(request),
    });
    expect(response.status).toBe(201);
    const { incidentId } = (await response.json()) as { incidentId: string };
    const [messages, queued] = await Promise.all([
      __fixture.admin.db
        .select({ content: incidentMessages.content })
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId)),
      __fixture.admin.db
        .select({ payload: jobs.payload })
        .from(jobs)
        .where(sql`payload->>'incidentId' = ${incidentId}`),
    ]);
    expect(JSON.stringify(messages)).not.toContain(secret);
    expect(JSON.stringify(queued)).not.toContain(secret);
    expect(JSON.stringify(__fixture.apiLog.info.mock.calls)).not.toContain(secret);
  });

  test('rate limits new paid investigations but preserves idempotent retries', async () => {
    vi.stubEnv('MANUAL_INCIDENT_RATE_LIMIT_PER_MINUTE', '2');
    try {
      const token = await __fixture.sign(__fixture.orgB);
      const before = await durableManualCounts(__fixture.tenantB);
      const firstRequest = body();
      const post = (request: ReturnType<typeof body>) =>
        __fixture.api.request('/incidents', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });

      const first = await post(firstRequest);
      expect(first.status).toBe(201);
      const retry = await post(firstRequest);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ outcome: 'existing' });
      expect((await post(body())).status).toBe(201);

      const rejectedRequest = body();
      const limited = await post(rejectedRequest);
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('60');
      expect(await limited.json()).toEqual({ error: 'manual incident creation rate limited' });
      expect(await durableManualCounts(__fixture.tenantB)).toEqual({
        incidents: before.incidents + 2,
        openers: before.openers + 2,
        jobs: before.jobs + 2,
      });
      expect(
        await __fixture.admin.db
          .select({ id: incidents.id })
          .from(incidents)
          .where(eq(incidents.fingerprint, `manual:${rejectedRequest.requestId}`)),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('serializes concurrent manual-incident admission across transactions', async () => {
    vi.stubEnv('MANUAL_INCIDENT_RATE_LIMIT_PER_MINUTE', '1');
    try {
      const token = await __fixture.sign(__fixture.orgA);
      const before = await durableManualCounts(__fixture.tenantA);
      const post = (request: ReturnType<typeof body>) =>
        __fixture.api.request('/incidents', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(request),
        });

      const requests = [body(), body()];
      const responses = await Promise.all(requests.map(post));

      expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
      expect(await durableManualCounts(__fixture.tenantA)).toEqual({
        incidents: before.incidents + 1,
        openers: before.openers + 1,
        jobs: before.jobs + 1,
      });
      const rejectedIndex = responses.findIndex((response) => response.status === 429);
      expect(
        await __fixture.admin.db
          .select({ id: incidents.id })
          .from(incidents)
          .where(eq(incidents.fingerprint, `manual:${requests[rejectedIndex]!.requestId}`)),
      ).toHaveLength(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
