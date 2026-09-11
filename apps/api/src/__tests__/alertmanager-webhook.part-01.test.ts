import { randomUUID } from 'node:crypto';

import { expect, test } from 'vitest';

import { eq } from 'drizzle-orm';

import {
  alertCohorts,
  alertEpisodeIntakes,
  connectorConfigs,
  incidentMessages,
  incidentRelations,
  incidentSignals,
  incidents,
  jobs,
  surfaceBindings,
  withTenant,
} from '@sre/db';

import { createFixture } from './alertmanager-webhook.fixture';

const __fixture = createFixture();

test('splits grouped alerts into independent episodes, suppresses transport repeats, reassesses changes, and links recurrence', async () => {
  const grouped = __fixture.payload('fingerprint-a', '2026-08-26T00:00:00Z');
  grouped.alerts.push(
    __fixture.payload('fingerprint-b', '2026-08-26T00:00:20Z', {
      alertName: 'InventoryHighErrors',
    }).alerts[0]!,
  );
  expect((await __fixture.deliver(grouped)).status).toBe(200);
  expect(
    (await __fixture.deliver(__fixture.payload('fingerprint-a', '2026-08-26T00:00:00Z'))).status,
  ).toBe(200);
  expect(
    (
      await __fixture.deliver(
        __fixture.payload('fingerprint-a', '2026-08-26T00:00:00Z', {
          description: 'Ten percent of requests are now failing.',
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await __fixture.deliver(
        __fixture.payload('fingerprint-a', '2026-08-26T00:00:00Z', {
          status: 'resolved',
          description: 'Ten percent of requests are now failing.',
          endsAt: '2026-08-26T00:04:00Z',
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await __fixture.deliver(
        __fixture.payload('fingerprint-a', '2026-08-26T00:00:00Z', {
          description: 'A delayed firing delivery arrived after this episode resolved.',
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (await __fixture.deliver(__fixture.payload('fingerprint-a', '2026-08-26T00:05:00Z'))).status,
  ).toBe(200);

  const evidence = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => ({
    incidents: await tx.select().from(incidents).orderBy(incidents.createdAt),
    signals: await tx.select().from(incidentSignals).orderBy(incidentSignals.startsAt),
    intakes: await tx.select().from(alertEpisodeIntakes),
    cohorts: await tx.select().from(alertCohorts),
    relations: await tx.select().from(incidentRelations),
    messages: await tx.select().from(incidentMessages),
  }));
  const queuedJobs = await __fixture.admin.db
    .select({ type: jobs.type, payload: jobs.payload })
    .from(jobs)
    .where(eq(jobs.tenantId, __fixture.tenantId));

  expect(__fixture.postRoot).toHaveBeenCalledTimes(3);
  expect(evidence.incidents).toHaveLength(3);
  expect(evidence.intakes.every((intake) => intake.state === 'accepted')).toBe(true);
  expect(evidence.signals).toHaveLength(3);
  const first = evidence.signals.find(
    (signal) =>
      signal.providerFingerprint === __fixture.providerFingerprint('fingerprint-a') &&
      signal.state === 'resolved',
  );
  expect(first).toMatchObject({ version: 3, lastEventType: 'resolved' });
  expect(
    evidence.intakes.find(
      (intake) =>
        intake.providerFingerprint === __fixture.providerFingerprint('fingerprint-a') &&
        intake.startsAt.getTime() === Date.parse('2026-08-26T00:00:00Z'),
    )?.observation,
  ).toMatchObject({ status: 'resolved' });
  expect(queuedJobs.filter((job) => job.type === 'triage')).toHaveLength(3);
  expect(queuedJobs.filter((job) => job.type === 'signal.reassess')).toHaveLength(1);
  expect(queuedJobs.filter((job) => job.type === 'recovery.verify')).toHaveLength(1);
  expect(queuedJobs.filter((job) => job.type === 'cohort.analyze')).toHaveLength(1);
  expect(evidence.cohorts).toHaveLength(1);
  expect(evidence.relations.filter((relation) => relation.type === 'recurrence_of')).toHaveLength(
    1,
  );
  expect(
    evidence.relations.filter((relation) => relation.type === 'possible_related'),
  ).toHaveLength(0);
  expect(evidence.messages.filter((message) => message.kind === 'relationship')).toHaveLength(2);
  expect(
    queuedJobs
      .filter((job) => job.type === 'triage')
      .every(
        (job) =>
          (job.payload as { investigationTrigger?: { reason?: string } }).investigationTrigger
            ?.reason === 'new_episode',
      ),
  ).toBe(true);
});

test('never retries an ambiguous Slack root creation', async () => {
  const before = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) =>
    tx
      .select({ eventCount: connectorConfigs.eventCount })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, __fixture.connectorId))
      .limit(1),
  );
  const alert = __fixture.payload('fingerprint-uncertain', '2026-08-26T01:00:00Z', {
    alertName: 'UncertainRoot',
  });
  expect((await __fixture.deliver(alert)).status).toBe(503);
  expect((await __fixture.deliver(alert)).status).toBe(202);
  expect(
    __fixture.postRoot.mock.calls.filter((call) => call[2].includes('UncertainRoot')),
  ).toHaveLength(1);
  const rows = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .select()
      .from(alertEpisodeIntakes)
      .where(
        eq(
          alertEpisodeIntakes.providerFingerprint,
          __fixture.providerFingerprint('fingerprint-uncertain'),
        ),
      ),
  );
  expect(rows[0]).toMatchObject({ state: 'uncertain', rootMessageId: null, attemptCount: 1 });
  const after = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) =>
    tx
      .select({
        eventCount: connectorConfigs.eventCount,
        failureCategory: connectorConfigs.eventFailureCategory,
      })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, __fixture.connectorId))
      .limit(1),
  );
  expect(after[0]).toMatchObject({
    eventCount: before[0]!.eventCount,
    failureCategory: 'slack_transport_failure',
  });
});

test('keeps Alertmanager retrying while another root attempt still owns the posting fence', async () => {
  const startsAt = new Date('2026-08-26T01:20:00Z');
  const intakeId = randomUUID();
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx.insert(alertEpisodeIntakes).values({
      id: intakeId,
      tenantId: __fixture.tenantId,
      dataSourceId: __fixture.connectorId,
      providerFingerprint: __fixture.providerFingerprint('fingerprint-posting'),
      startsAt,
      materialHash: 'posting-in-progress',
      observation: {
        status: 'firing',
        groupKey: '{}:{alertname="PostingRoot"}',
        alertName: 'PostingRoot',
        labels: { alertname: 'PostingRoot', service: 'checkout' },
        annotations: { summary: 'Posting root in progress' },
        endsAt: null,
        generatorUrl: null,
        externalUrl: null,
      },
      channel: 'C07ALERTS',
      state: 'posting',
      attemptCount: 1,
    }),
  );
  const before = __fixture.postRoot.mock.calls.length;

  expect(
    (
      await __fixture.deliver(
        __fixture.payload('fingerprint-posting', startsAt.toISOString(), {
          alertName: 'PostingRoot',
        }),
      )
    ).status,
  ).toBe(503);
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
  const intake = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) =>
    tx.select().from(alertEpisodeIntakes).where(eq(alertEpisodeIntakes.id, intakeId)).limit(1),
  );
  expect(intake[0]).toMatchObject({ state: 'posting', attemptCount: 1 });
});

test('routes retries from the durable resolved observation and original Slack channel', async () => {
  const fingerprint = __fixture.providerFingerprint('durable-resolved-retry');
  const startsAt = new Date('2026-08-26T01:22:00Z');
  const rootMessageId = '1788120000.000001';
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx.insert(alertEpisodeIntakes).values({
      tenantId: __fixture.tenantId,
      dataSourceId: __fixture.connectorId,
      providerFingerprint: fingerprint,
      startsAt,
      materialHash: 'durable-resolved-material',
      observation: {
        status: 'resolved',
        groupKey: '{}:{alertname="DurableResolvedSnapshot"}',
        alertName: 'DurableResolvedSnapshot',
        labels: {
          alertname: 'DurableResolvedSnapshot',
          service: 'checkout',
          severity: 'warning',
        },
        annotations: { summary: 'The stored episode is resolved.' },
        endsAt: '2026-08-26T01:23:00.000Z',
        generatorUrl: null,
        externalUrl: null,
      },
      channel: 'C-ORIGINAL-ALERTS',
      state: 'posted',
      rootMessageId,
      attemptCount: 1,
    }),
  );
  const postsBefore = __fixture.postRoot.mock.calls.length;

  expect(
    (
      await __fixture.deliver(
        __fixture.payload('durable-resolved-retry', startsAt.toISOString(), {
          alertName: 'StaleFiringRedelivery',
          description: 'This firing delivery arrived after the resolved observation.',
        }),
      )
    ).status,
  ).toBe(200);

  const evidence = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
    const signals = await tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.providerFingerprint, fingerprint));
    return {
      signal: signals[0],
      bindings: signals[0]
        ? await tx
            .select()
            .from(surfaceBindings)
            .where(eq(surfaceBindings.incidentId, signals[0].incidentId))
        : [],
    };
  });
  expect(__fixture.postRoot).toHaveBeenCalledTimes(postsBefore);
  expect(evidence.signal).toMatchObject({
    state: 'resolved',
    lastEventType: 'resolved',
    summary: expect.stringContaining('[RESOLVED] DurableResolvedSnapshot'),
  });
  expect(evidence.bindings).toEqual([
    expect.objectContaining({ channel: 'C-ORIGINAL-ALERTS', threadId: rootMessageId }),
  ]);
});

test('a rejected root attempt adopts the corrected configured channel before retrying', async () => {
  const fingerprint = __fixture.providerFingerprint('rejected-channel-retry');
  const startsAt = new Date('2026-08-26T01:24:00Z');
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx.insert(alertEpisodeIntakes).values({
      tenantId: __fixture.tenantId,
      dataSourceId: __fixture.connectorId,
      providerFingerprint: fingerprint,
      startsAt,
      materialHash: 'rejected-channel-material',
      observation: {
        status: 'firing',
        groupKey: '{}:{alertname="RejectedChannelRetry"}',
        alertName: 'RejectedChannelRetry',
        labels: { alertname: 'RejectedChannelRetry', service: 'checkout' },
        annotations: { summary: 'Retry this root in the corrected channel.' },
        endsAt: null,
        generatorUrl: null,
        externalUrl: null,
      },
      channel: 'C-INVALID-OLD-CHANNEL',
      state: 'rejected',
      attemptCount: 1,
      failureCategory: 'channel_not_found',
    }),
  );
  const postsBefore = __fixture.postRoot.mock.calls.length;

  expect(
    (
      await __fixture.deliver(
        __fixture.payload('rejected-channel-retry', startsAt.toISOString(), {
          alertName: 'RejectedChannelRetry',
        }),
      )
    ).status,
  ).toBe(200);

  expect(__fixture.postRoot.mock.calls[postsBefore]?.[1]).toBe('C07ALERTS');
  const intake = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.providerFingerprint, fingerprint))
      .limit(1),
  );
  expect(intake[0]).toMatchObject({ state: 'accepted', channel: 'C07ALERTS', attemptCount: 2 });
});

test('serializes concurrent first deliveries into one Slack root and one incident', async () => {
  const fingerprint = __fixture.providerFingerprint('fingerprint-concurrent');
  const alert = __fixture.payload('fingerprint-concurrent', '2026-08-26T01:25:00Z', {
    alertName: 'ConcurrentRoot',
  });
  let signalStarted!: () => void;
  let releasePost!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const waitForRelease = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  __fixture.concurrentRootGate = { started: signalStarted, waitForRelease };
  try {
    const winnerRequest = __fixture.deliver(alert);
    await started;
    expect((await __fixture.deliver(alert)).status).toBe(503);
    releasePost();
    expect((await winnerRequest).status).toBe(200);
    expect((await __fixture.deliver(alert)).status).toBe(200);
  } finally {
    releasePost();
    __fixture.concurrentRootGate = undefined;
  }

  expect(
    __fixture.postRoot.mock.calls.filter((call) => call[2].includes('ConcurrentRoot')),
  ).toHaveLength(1);
  const evidence = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
    const intakeRows = await tx
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.providerFingerprint, fingerprint));
    const signalRows = await tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.providerFingerprint, fingerprint));
    const incidentId = intakeRows[0]?.incidentId;
    return {
      intakes: intakeRows,
      signals: signalRows,
      incidents: incidentId
        ? await tx.select().from(incidents).where(eq(incidents.id, incidentId))
        : [],
      bindings: incidentId
        ? await tx.select().from(surfaceBindings).where(eq(surfaceBindings.incidentId, incidentId))
        : [],
    };
  });
  const incidentId = evidence.intakes[0]?.incidentId;
  const triageJobs = (
    await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
  ).filter(
    (job) =>
      job.type === 'triage' &&
      (job.payload as { incidentId?: string } | null)?.incidentId === incidentId,
  );
  expect(evidence.intakes).toEqual([
    expect.objectContaining({ state: 'accepted', attemptCount: 1 }),
  ]);
  expect(evidence.signals).toHaveLength(1);
  expect(evidence.incidents).toHaveLength(1);
  expect(evidence.bindings).toHaveLength(1);
  expect(triageJobs).toHaveLength(1);
});

test('marks an interrupted root attempt uncertain instead of posting a duplicate', async () => {
  const startsAt = new Date('2026-08-26T01:30:00Z');
  const intakeId = randomUUID();
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx.insert(alertEpisodeIntakes).values({
      id: intakeId,
      tenantId: __fixture.tenantId,
      dataSourceId: __fixture.connectorId,
      providerFingerprint: __fixture.providerFingerprint('fingerprint-interrupted'),
      startsAt,
      materialHash: 'before-redelivery',
      observation: {
        status: 'firing',
        groupKey: '{}:{alertname="InterruptedRoot"}',
        alertName: 'InterruptedRoot',
        labels: { alertname: 'InterruptedRoot', service: 'checkout' },
        annotations: { summary: 'Interrupted root post' },
        endsAt: null,
        generatorUrl: null,
        externalUrl: null,
      },
      channel: 'C07ALERTS',
      state: 'posting',
      attemptCount: 1,
      updatedAt: new Date(Date.now() - 60_000),
    }),
  );
  const before = __fixture.postRoot.mock.calls.length;
  const alert = __fixture.payload('fingerprint-interrupted', startsAt.toISOString(), {
    alertName: 'InterruptedRoot',
  });

  const interrupted = await __fixture.deliver(alert);
  expect({ status: interrupted.status, body: await interrupted.json() }).toEqual({
    status: 503,
    body: { error: 'Alertmanager notification processing failed' },
  });
  const stateAfterInterruption = await withTenant(
    __fixture.app.db,
    __fixture.tenantId,
    async (tx) => {
      const rows = await tx
        .select({ state: alertEpisodeIntakes.state })
        .from(alertEpisodeIntakes)
        .where(eq(alertEpisodeIntakes.id, intakeId))
        .limit(1);
      return rows[0]?.state;
    },
  );
  expect(stateAfterInterruption).toBe('uncertain');
  const deferred = await __fixture.deliver(alert);
  expect({ status: deferred.status, body: await deferred.json() }).toEqual({
    status: 202,
    body: { accepted: false, alerts: 1, deferred: 1 },
  });
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
  const intake = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) =>
    tx.select().from(alertEpisodeIntakes).where(eq(alertEpisodeIntakes.id, intakeId)).limit(1),
  );
  expect(intake[0]).toMatchObject({
    state: 'uncertain',
    failureCategory: 'process_interrupted',
    attemptCount: 1,
  });
});

test('rejects the wrong bearer token before parsing or posting', async () => {
  const before = __fixture.postRoot.mock.calls.length;
  expect(
    (
      await __fixture.deliver(
        __fixture.payload('fingerprint-auth', '2026-08-26T02:00:00Z'),
        'wrong-token',
      )
    ).status,
  ).toBe(401);
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
});

test('rejects a malformed webhook key before querying connector state', async () => {
  const before = __fixture.postRoot.mock.calls.length;
  const response = await __fixture.api.request(`/webhooks/alertmanager/${'-'.repeat(36)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${__fixture.EVENT_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(__fixture.payload('fingerprint-bad-key', '2026-08-26T02:05:00Z')),
  });

  expect(response.status).toBe(404);
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
});

test('redacts provider-controlled secrets before every durable and external sink', async () => {
  const formattedSecret = `sk-${'Ab1'.repeat(12)}`;
  const keyNamedSecret = 'plain-value-hidden-by-sensitive-key';
  const body = __fixture.payload('fingerprint-redaction', '2026-08-26T02:10:00Z');
  body.groupKey = `{alertname="SecretAlert",token="${formattedSecret}"}`;
  body.externalURL = `https://alertmanager.example/${__fixture.EVENT_TOKEN}?credential=${formattedSecret}`;
  (body.alerts[0]!.labels as Record<string, string>).api_token = keyNamedSecret;
  (body.alerts[0]!.labels as Record<string, string>).deployment =
    `release-${__fixture.EVENT_TOKEN}`;
  body.alerts[0]!.annotations.summary = `Secret appeared: ${formattedSecret} ${__fixture.EVENT_TOKEN}`;
  body.alerts[0]!.annotations.description = `Bearer ${formattedSecret}`;
  body.alerts[0]!.generatorURL = `https://prometheus.example/${__fixture.EVENT_TOKEN}/graph?token=${formattedSecret}`;

  expect((await __fixture.deliver(body)).status).toBe(200);
  const persisted = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
    const signalRows = await tx
      .select()
      .from(incidentSignals)
      .where(
        eq(
          incidentSignals.providerFingerprint,
          __fixture.providerFingerprint('fingerprint-redaction'),
        ),
      );
    const intakeRows = await tx
      .select()
      .from(alertEpisodeIntakes)
      .where(
        eq(
          alertEpisodeIntakes.providerFingerprint,
          __fixture.providerFingerprint('fingerprint-redaction'),
        ),
      );
    const signal = signalRows[0]!;
    return {
      signal,
      intake: intakeRows[0],
      messages: await tx
        .select()
        .from(incidentMessages)
        .where(eq(incidentMessages.incidentId, signal.incidentId)),
    };
  });
  const queued = (
    await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
  ).filter(
    (job) => (job.payload as { incidentId?: string }).incidentId === persisted.signal.incidentId,
  );
  const rootText = String(__fixture.postRoot.mock.calls.at(-1)?.[2] ?? '');
  const allSinks = JSON.stringify({ persisted, queued, rootText });

  expect(allSinks).not.toContain(formattedSecret);
  expect(allSinks).not.toContain(keyNamedSecret);
  expect(allSinks).not.toContain(__fixture.EVENT_TOKEN);
  expect(allSinks).toContain('[REDACTED]');
});

test('rejects oversized raw group metadata before hashing it', async () => {
  const before = __fixture.postRoot.mock.calls.length;
  const body = __fixture.payload('fingerprint-large-group', '2026-08-26T02:12:00Z');
  body.groupKey = 'x'.repeat(16_385);

  const response = await __fixture.deliver(body);
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'invalid Alertmanager group metadata' });
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
});

test('rejects a non-provider fingerprint without creating incident state or external work', async () => {
  const snapshot = async () =>
    withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => ({
      intakes: (await tx.select({ id: alertEpisodeIntakes.id }).from(alertEpisodeIntakes)).length,
      signals: (await tx.select({ id: incidentSignals.id }).from(incidentSignals)).length,
      incidents: (await tx.select({ id: incidents.id }).from(incidents)).length,
      bindings: (await tx.select({ id: surfaceBindings.id }).from(surfaceBindings)).length,
      messages: (await tx.select({ id: incidentMessages.id }).from(incidentMessages)).length,
      jobs: (
        await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
      ).length,
    }));
  const before = await snapshot();
  const postCount = __fixture.postRoot.mock.calls.length;
  const body = __fixture.payload('ignored-invalid-fingerprint', '2026-08-26T02:15:00Z');
  body.alerts[0]!.fingerprint = `sk-${'Ab1'.repeat(12)}`;

  expect((await __fixture.deliver(body)).status).toBe(400);
  expect(__fixture.postRoot).toHaveBeenCalledTimes(postCount);
  expect(await snapshot()).toEqual(before);
});

test('rejects a former event token when connector settings disable delivery', async () => {
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        settings: {
          baseUrl: 'https://prometheus.example',
          authType: 'none',
          eventTransport: 'none',
          cohortWindowSec: 120,
        },
      })
      .where(eq(connectorConfigs.id, __fixture.connectorId)),
  );
  const before = __fixture.postRoot.mock.calls.length;

  expect(
    (await __fixture.deliver(__fixture.payload('fingerprint-disabled', '2026-08-26T02:20:00Z')))
      .status,
  ).toBe(409);
  expect(__fixture.postRoot).toHaveBeenCalledTimes(before);
});
