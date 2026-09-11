import { describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import {
  applySignalObservation,
  createIncident,
  incidentMessages,
  incidentSignals,
  jobs,
} from '@sre/db';

import { createFixture } from './incidents.fixture';

const __fixture = createFixture();

describe('POST /incidents/:id/signals/:signalId/correct', () => {
  test('rejects a correction timestamp older than the latest provider observation', async () => {
    const incidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `invalid-time-signal-correction-${randomUUID()}`,
        alertSource: 'slack',
        service: 'statuscake',
        severity: 'sev3',
      })
    ).id;
    const observedAt = new Date(Date.now() - 30_000);
    const signal = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.099999`,
        state: 'firing',
        summary: 'StatusCake checkout is down',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: observedAt,
      })
    ).signal;
    const requestId = randomUUID();

    const response = await __fixture.api.request(
      `/incidents/${incidentId}/signals/${signal.id}/correct`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Invalid historical correction.',
          requestId,
          expectedVersion: signal.version,
          resolvedAt: new Date(observedAt.getTime() - 1).toISOString(),
        }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid resolvedAt' });
    const [stored] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id));
    expect(stored).toMatchObject({ state: 'firing', version: 1 });
    expect(
      await __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(
          eq(
            incidentMessages.transitionKey,
            `dashboard-signal-correction:${incidentId}:${signal.id}:${requestId}`,
          ),
        ),
    ).toHaveLength(0);
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, __fixture.tenantC),
            eq(jobs.type, 'recovery.verify'),
            sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
          ),
        ),
    ).toHaveLength(0);
  });

  test('operator correction is version-fenced, audited, idempotent, and queues active recovery', async () => {
    const incidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `signal-correction-${randomUUID()}`,
        alertSource: 'slack',
        service: 'statuscake',
        severity: 'sev3',
      })
    ).id;
    const observedAt = new Date(Date.now() - 60_000);
    const signal = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.100001`,
        state: 'firing',
        summary: 'StatusCake checkout went Down',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: observedAt,
      })
    ).signal;
    const requestId = randomUUID();
    const token = await __fixture.sign(__fixture.orgC);
    const post = (body: unknown, bearer = token) =>
      __fixture.api.request(`/incidents/${incidentId}/signals/${signal.id}/correct`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    const body = {
      reason: 'The later StatusCake Up notification confirms recovery.',
      requestId,
      expectedVersion: signal.version,
      resolvedAt: new Date().toISOString(),
    };

    expect((await post(body, await __fixture.sign(__fixture.orgA))).status).toBe(403);
    const corrected = await post(body);
    expect(corrected.status).toBe(200);
    expect(await corrected.json()).toMatchObject({
      correction: { outcome: 'applied', signalId: signal.id, version: 2 },
    });
    const duplicate = await post(body);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ correction: { outcome: 'noop', version: 2 } });

    const [stored] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id));
    expect(stored).toMatchObject({ state: 'resolved', lastEventType: 'resolved', version: 2 });
    const auditRows = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(
        eq(
          incidentMessages.transitionKey,
          `dashboard-signal-correction:${incidentId}:${signal.id}:${requestId}`,
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      author: 'human',
      authorUserId: __fixture.tenantCUserId,
      kind: 'signal',
      signalId: signal.id,
      signalState: 'resolved',
      signalEventType: 'resolved',
    });
    const recoveryJobs = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, __fixture.tenantC),
          eq(jobs.type, 'recovery.verify'),
          sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
        ),
      );
    expect(recoveryJobs).toHaveLength(1);

    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId,
      surface: 'slack',
      channel: __fixture.ORIGIN_CHANNEL_ID,
      externalMessageId: signal.externalMessageId,
      state: 'firing',
      summary: 'Delayed StatusCake checkout went Down delivery',
      contentHash: randomUUID(),
      eventKey: `slack:${randomUUID()}`,
      eventAt: new Date(new Date(body.resolvedAt).getTime() - 1),
    });
    const [afterDelayedFiring] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id));
    expect(afterDelayedFiring).toMatchObject({
      state: 'resolved',
      lastEventType: 'resolved',
      version: 2,
    });

    await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
      incidentId,
      surface: 'slack',
      channel: __fixture.ORIGIN_CHANNEL_ID,
      externalMessageId: signal.externalMessageId,
      state: 'firing',
      summary: 'StatusCake checkout went Down again',
      contentHash: randomUUID(),
      eventKey: `slack:${randomUUID()}`,
      eventAt: new Date(new Date(body.resolvedAt).getTime() + 1_000),
    });
    const oldRequestAfterRefire = await post(body);
    expect(oldRequestAfterRefire.status).toBe(409);
    expect(await oldRequestAfterRefire.json()).toEqual({ error: 'stale' });
    const [refired] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id));
    expect(refired).toMatchObject({ state: 'firing', lastEventType: 'refired', version: 3 });
    expect(
      await __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(
          eq(
            incidentMessages.transitionKey,
            `dashboard-signal-correction:${incidentId}:${signal.id}:${requestId}`,
          ),
        ),
    ).toHaveLength(1);

    const stale = await post({ ...body, requestId: randomUUID(), expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale' });
  });

  test('terminal correction reconciles the projection without buying another recovery run', async () => {
    const incidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `terminal-signal-correction-${randomUUID()}`,
        alertSource: 'slack',
        service: 'statuscake',
        severity: 'sev3',
      })
    ).id;
    const signal = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.100002`,
        state: 'firing',
        summary: 'StatusCake checkout went Up was misclassified',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: new Date(Date.now() - 60_000),
      })
    ).signal;
    await __fixture.hub.transitionIncident(__fixture.tenantC, incidentId, {
      to: 'resolved',
      reason: 'Responder confirmed recovery.',
      transitionKey: `test-terminal:${incidentId}`,
      author: 'human',
      authorUserId: __fixture.tenantCUserId,
    });

    const response = await __fixture.api.request(
      `/incidents/${incidentId}/signals/${signal.id}/correct`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'This Up message is a recovery observation, not a firing alert.',
          requestId: randomUUID(),
          expectedVersion: signal.version,
        }),
      },
    );
    expect(response.status).toBe(200);
    const recoveryJobs = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, __fixture.tenantC),
          eq(jobs.type, 'recovery.verify'),
          sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
        ),
      );
    expect(recoveryJobs).toHaveLength(0);
  });

  test('queues recovery only after the final active signal is corrected', async () => {
    const incidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantC, {
        fingerprint: `multi-signal-correction-${randomUUID()}`,
        alertSource: 'slack',
        service: 'statuscake',
        severity: 'sev3',
      })
    ).id;
    const observedAt = new Date(Date.now() - 60_000);
    const first = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.200001`,
        state: 'firing',
        summary: 'checkout.example.com is down',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: observedAt,
      })
    ).signal;
    const second = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.200002`,
        state: 'firing',
        summary: 'api.example.com is down',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: observedAt,
      })
    ).signal;
    const token = await __fixture.sign(__fixture.orgC);
    const correct = (signal: typeof first) =>
      __fixture.api.request(`/incidents/${incidentId}/signals/${signal.id}/correct`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          reason: 'Provider recovery was verified independently.',
          requestId: randomUUID(),
          expectedVersion: signal.version,
        }),
      });
    const recoveryJobs = () =>
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.tenantId, __fixture.tenantC),
            eq(jobs.type, 'recovery.verify'),
            sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
          ),
        );

    expect((await correct(first)).status).toBe(200);
    expect(await recoveryJobs()).toHaveLength(0);
    expect((await correct(second)).status).toBe(200);
    expect(await recoveryJobs()).toHaveLength(1);
  });

  test.each(['audit publish', 'recovery publish'] as const)(
    'retains durable correction state when %s fails after commit',
    async (failure) => {
      const incidentId = (
        await createIncident(__fixture.app.db, __fixture.tenantC, {
          fingerprint: `post-commit-correction-${failure}-${randomUUID()}`,
          alertSource: 'slack',
          service: 'statuscake',
          severity: 'sev3',
        })
      ).id;
      const signal = (
        await applySignalObservation(__fixture.app.db, __fixture.tenantC, {
          incidentId,
          surface: 'slack',
          channel: __fixture.ORIGIN_CHANNEL_ID,
          externalMessageId: `${Date.now()}.${failure === 'audit publish' ? '300001' : '300002'}`,
          state: 'firing',
          summary: 'StatusCake post-commit failure test',
          contentHash: randomUUID(),
          eventKey: `slack:${randomUUID()}`,
          eventAt: new Date(Date.now() - 30_000),
        })
      ).signal;
      const requestId = randomUUID();
      const publishSpy =
        failure === 'audit publish'
          ? vi
              .spyOn(__fixture.hub, 'publishAppended')
              .mockRejectedValueOnce(new Error('redis unavailable'))
          : vi
              .spyOn(__fixture.declarationQueue, 'publishJob')
              .mockRejectedValueOnce(new Error('redis unavailable'));

      const response = await __fixture.api.request(
        `/incidents/${incidentId}/signals/${signal.id}/correct`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            reason: 'Recovery independently verified.',
            requestId,
            expectedVersion: signal.version,
          }),
        },
      );
      publishSpy.mockRestore();

      expect(response.status).toBe(200);
      const [stored] = await __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.id, signal.id));
      expect(stored).toMatchObject({ state: 'resolved', version: 2 });
      expect(
        await __fixture.admin.db
          .select()
          .from(incidentMessages)
          .where(
            eq(
              incidentMessages.transitionKey,
              `dashboard-signal-correction:${incidentId}:${signal.id}:${requestId}`,
            ),
          ),
      ).toHaveLength(1);
      expect(
        await __fixture.admin.db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.tenantId, __fixture.tenantC),
              eq(jobs.type, 'recovery.verify'),
              sql`${jobs.payload}->>'incidentId' = ${incidentId}`,
            ),
          ),
      ).toHaveLength(1);
    },
  );

  test('a platform operator remains confined to the tenant resolved from the session', async () => {
    const incidentId = (
      await createIncident(__fixture.app.db, __fixture.tenantA, {
        fingerprint: `cross-tenant-signal-correction-${randomUUID()}`,
        alertSource: 'slack',
        service: 'statuscake',
        severity: 'sev3',
      })
    ).id;
    const signal = (
      await applySignalObservation(__fixture.app.db, __fixture.tenantA, {
        incidentId,
        surface: 'slack',
        channel: __fixture.ORIGIN_CHANNEL_ID,
        externalMessageId: `${Date.now()}.100003`,
        state: 'firing',
        summary: 'StatusCake tenant A check is down',
        contentHash: randomUUID(),
        eventKey: `slack:${randomUUID()}`,
        eventAt: new Date(Date.now() - 60_000),
      })
    ).signal;

    const response = await __fixture.api.request(
      `/incidents/${incidentId}/signals/${signal.id}/correct`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await __fixture.sign(__fixture.orgC)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          reason: 'Must not cross the tenant boundary.',
          requestId: randomUUID(),
          expectedVersion: signal.version,
        }),
      },
    );

    expect(response.status).toBe(404);
    const [stored] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id));
    expect(stored).toMatchObject({ state: 'firing', version: 1 });
    expect(
      await __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, incidentId)),
    ).toHaveLength(0);
  });
});
