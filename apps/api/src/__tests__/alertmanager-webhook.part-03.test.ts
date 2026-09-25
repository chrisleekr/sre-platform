import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  incidents,
  subscribeChannel,
  inboundChannels,
  incidentRelations,
  incidentSignals,
  jobs,
  signalDispositions,
  surfaceBindings,
  withTenant,
} from '@sre/db';
import { createFixture } from './alertmanager-webhook.fixture';

const fixture = createFixture();

test('persists scrubbed firing and resolved dispositions idempotently', async () => {
  const alertName = `DispositionLifecycle-${randomUUID()}`;
  const fingerprint = `disposition-lifecycle-${randomUUID()}`;
  const startsAt = '2026-09-02T02:00:00Z';
  const secret = 'password=hunter2';
  const firing = fixture.payload(fingerprint, startsAt, {
    alertName,
    description: `Checkout failures include ${secret}`,
  });
  const resolved = fixture.payload(fingerprint, startsAt, {
    alertName,
    description: `Checkout recovered; ${secret}`,
    status: 'resolved',
    endsAt: '2026-09-02T02:05:00Z',
  });

  expect((await fixture.deliver(firing)).status).toBe(200);
  expect((await fixture.deliver(firing)).status).toBe(200);
  expect((await fixture.deliver(resolved)).status).toBe(200);
  const rows = await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    tx
      .select()
      .from(signalDispositions)
      .where(eq(signalDispositions.dataSourceId, fixture.connectorId)),
  );
  const lifecycle = rows.filter((row) => row.summary.includes(alertName));
  expect(lifecycle).toHaveLength(2);
  expect(lifecycle.filter((row) => row.supersededAt === null)).toEqual([
    expect.objectContaining({ disposition: 'log', effectiveDisposition: 'log' }),
  ]);
  expect(lifecycle.filter((row) => row.supersededAt !== null)).toEqual([
    expect.objectContaining({ disposition: 'investigate', effectiveDisposition: 'investigate' }),
  ]);
  expect(JSON.stringify(lifecycle)).not.toContain('hunter2');
});

test('keeps a later provider episode independent while the prior monitor episode is still firing', async () => {
  const alertName = `ConcurrentMonitorEpisode-${randomUUID()}`;
  const fingerprint = `concurrent-monitor-${randomUUID()}`;
  const firstStartsAt = '2026-08-26T00:30:00Z';
  const secondStartsAt = '2026-08-26T00:31:00Z';
  const rootsBefore = fixture.postRoot.mock.calls.length;

  expect(
    (await fixture.deliver(fixture.payload(fingerprint, firstStartsAt, { alertName }))).status,
  ).toBe(200);
  expect(
    (await fixture.deliver(fixture.payload(fingerprint, secondStartsAt, { alertName }))).status,
  ).toBe(200);

  const providerFingerprint = fixture.providerFingerprint(fingerprint);
  const evidence = await withTenant(fixture.app.db, fixture.tenantId, async (tx) => {
    const signals = await tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.providerFingerprint, providerFingerprint));
    const incidentIds = [...new Set(signals.map((signal) => signal.incidentId))];
    return {
      signals,
      incidentIds,
      bindings: await tx
        .select()
        .from(surfaceBindings)
        .where(inArray(surfaceBindings.incidentId, incidentIds)),
      relations: await tx
        .select()
        .from(incidentRelations)
        .where(eq(incidentRelations.type, 'recurrence_of')),
    };
  });
  const triageJobs = (
    await fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, fixture.tenantId))
  ).filter(
    (job) =>
      job.type === 'triage' &&
      evidence.incidentIds.includes((job.payload as { incidentId?: string }).incidentId ?? ''),
  );

  expect(evidence.signals).toHaveLength(2);
  expect(evidence.incidentIds).toHaveLength(2);
  expect(evidence.bindings).toHaveLength(2);
  expect(new Set(evidence.bindings.map((binding) => binding.threadId)).size).toBe(2);
  expect(triageJobs).toHaveLength(2);
  expect(fixture.postRoot.mock.calls.length - rootsBefore).toBe(2);
  expect(
    evidence.relations.some(
      (relation) =>
        evidence.incidentIds.includes(relation.sourceIncidentId) &&
        evidence.incidentIds.includes(relation.targetIncidentId),
    ),
  ).toBe(true);
});

const subscription = (enabled: boolean) =>
  subscribeChannel(fixture.app.db, {
    tenantId: fixture.tenantId,
    surface: 'slack',
    channel: 'C07ALERTS',
    enabled,
  });
const health = async () =>
  (
    await fixture.admin.db
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, fixture.connectorId))
  )[0]!;
const counts = async () => ({
  incidents: (
    await fixture.admin.db
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.tenantId, fixture.tenantId))
  ).length,
  jobs: (
    await fixture.admin.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.tenantId, fixture.tenantId))
  ).length,
});

test.each(['absent', 'disabled'] as const)(
  'refuses a new native root when its subscription is %s with observable delivery failure',
  async (mode) => {
    if (mode === 'absent')
      await fixture.admin.db
        .delete(inboundChannels)
        .where(eq(inboundChannels.tenantId, fixture.tenantId));
    else await subscription(false);
    const before = await counts();
    const beforeHealth = await health();
    try {
      const response = await fixture.deliver(fixture.payload(randomUUID(), '2026-09-02T05:00:00Z'));
      expect(response.status).toBe(503);
      expect(fixture.postRoot).not.toHaveBeenCalled();
      expect(await counts()).toEqual(before);
      expect(await health()).toMatchObject({
        eventFailureCategory: 'channel_unsubscribed',
        eventCount: beforeHealth.eventCount,
      });
    } finally {
      await subscription(true);
    }
  },
);

test('retains a successful root when subscription is revoked during posting and routes it once after resubscription', async () => {
  const body = fixture.payload(randomUUID(), '2026-09-02T05:10:00Z');
  const before = await counts();
  fixture.postRoot.mockImplementationOnce(async () => {
    await subscription(false);
    return '1901.000001';
  });
  try {
    expect((await fixture.deliver(body)).status).toBe(503);
    const [posted] = await fixture.admin.db
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.providerFingerprint, body.alerts[0]!.fingerprint));
    expect(posted).toMatchObject({
      state: 'posted',
      rootMessageId: '1901.000001',
      failureCategory: null,
      incidentId: null,
    });
    expect(await counts()).toEqual(before);
    expect(await health()).toMatchObject({ eventFailureCategory: 'channel_unsubscribed' });
    expect((await fixture.deliver(body)).status).toBe(503);
    expect(fixture.postRoot).toHaveBeenCalledTimes(1);
    await subscription(true);
    expect((await fixture.deliver(body)).status).toBe(200);
    expect(fixture.postRoot).toHaveBeenCalledTimes(1);
    const [accepted] = await fixture.admin.db
      .select()
      .from(alertEpisodeIntakes)
      .where(eq(alertEpisodeIntakes.id, posted!.id));
    expect(accepted).toMatchObject({
      state: 'accepted',
      rootMessageId: '1901.000001',
      incidentId: expect.any(String),
    });
    expect((await counts()).incidents).toBe(before.incidents + 1);
  } finally {
    await subscription(true);
  }
});

test('threads durable intake identity into the root sender and accepts provider recovery after subscription revocation', async () => {
  const label = randomUUID();
  const startsAt = '2026-09-02T05:20:00Z';
  expect((await fixture.deliver(fixture.payload(label, startsAt))).status).toBe(200);
  const [intake] = await fixture.admin.db
    .select()
    .from(alertEpisodeIntakes)
    .where(eq(alertEpisodeIntakes.providerFingerprint, fixture.providerFingerprint(label)));
  expect([...fixture.postRoot.mock.calls[0]!][3]).toBe(intake!.id);
  await subscription(false);
  try {
    const response = await fixture.deliver(
      fixture.payload(label, startsAt, { status: 'resolved', endsAt: '2026-09-02T05:25:00Z' }),
    );
    expect(response.status).toBe(200);
    const [signal] = await fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, intake!.incidentId!));
    expect(signal).toMatchObject({ state: 'resolved', clearProvenance: 'provider' });
    expect(fixture.postRoot).toHaveBeenCalledTimes(1);
    expect(
      (
        await fixture.admin.db
          .select()
          .from(alertEpisodeIntakes)
          .where(eq(alertEpisodeIntakes.id, intake!.id))
      )[0]?.state,
    ).toBe('accepted');
  } finally {
    await subscription(true);
  }
});

test('checks the persisted destination subscription when configured and posted channels differ', async () => {
  const originalChannel = 'C-ORIGINAL-ALERTS';
  const rootMessageId = '1902.000001';
  const startsAt = '2026-09-02T05:30:00Z';
  const label = randomUUID();
  const body = fixture.payload(label, startsAt);
  const [posted] = await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    tx
      .insert(alertEpisodeIntakes)
      .values({
        tenantId: fixture.tenantId,
        dataSourceId: fixture.connectorId,
        providerFingerprint: fixture.providerFingerprint(label),
        startsAt: new Date(startsAt),
        materialHash: 'persisted-channel-subscription',
        observation: {
          status: 'firing',
          groupKey: body.groupKey,
          alertName: 'CheckoutHighErrors',
          labels: body.alerts[0]!.labels,
          annotations: body.alerts[0]!.annotations,
          endsAt: null,
          generatorUrl: null,
          externalUrl: null,
        },
        channel: originalChannel,
        state: 'posted',
        rootMessageId,
        attemptCount: 1,
      })
      .returning(),
  );
  const originalSubscription = (enabled: boolean) =>
    subscribeChannel(fixture.app.db, {
      tenantId: fixture.tenantId,
      surface: 'slack',
      channel: originalChannel,
      enabled,
    });
  const before = await counts();
  const beforeHealth = await health();
  expect(beforeHealth.settings).toMatchObject({ alertChannel: 'C07ALERTS' });
  await subscription(true);
  await originalSubscription(false);
  try {
    expect((await fixture.deliver(body)).status).toBe(503);
    expect(await health()).toMatchObject({
      eventFailureCategory: 'channel_unsubscribed',
      eventCount: beforeHealth.eventCount,
    });
    expect(await counts()).toEqual(before);
    expect(fixture.postRoot).not.toHaveBeenCalled();
    const readIntake = async () =>
      (
        await fixture.admin.db
          .select()
          .from(alertEpisodeIntakes)
          .where(eq(alertEpisodeIntakes.id, posted!.id))
      )[0]!;
    expect(await readIntake()).toMatchObject({
      state: 'posted',
      channel: originalChannel,
      rootMessageId,
      incidentId: null,
      bindingId: null,
      attemptCount: 1,
      failureCategory: null,
    });

    await originalSubscription(true);
    await subscription(false);
    expect((await fixture.deliver(body)).status).toBe(200);
    const accepted = await readIntake();
    expect(accepted).toMatchObject({
      state: 'accepted',
      channel: originalChannel,
      rootMessageId,
      incidentId: expect.any(String),
      attemptCount: 1,
    });
    expect((await counts()).incidents).toBe(before.incidents + 1);
    const bindings = await fixture.admin.db
      .select()
      .from(surfaceBindings)
      .where(eq(surfaceBindings.incidentId, accepted.incidentId!));
    expect(bindings).toEqual([
      expect.objectContaining({ channel: originalChannel, threadId: rootMessageId }),
    ]);
    const incidentJobs = () =>
      fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, fixture.tenantId));
    const triageCount = async () =>
      (await incidentJobs()).filter(
        (job) =>
          job.type === 'triage' &&
          (job.payload as { incidentId?: string }).incidentId === accepted.incidentId,
      ).length;
    expect(await triageCount()).toBe(1);
    const after = await counts();
    expect((await fixture.deliver(body)).status).toBe(200);
    expect(await counts()).toEqual(after);
    expect(await triageCount()).toBe(1);
    expect(fixture.postRoot).not.toHaveBeenCalled();
  } finally {
    await subscription(true);
    await originalSubscription(true);
  }
});
