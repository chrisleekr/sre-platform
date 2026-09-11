import { expect, test } from 'vitest';

import { and, eq, inArray } from 'drizzle-orm';

import {
  alertEpisodeIntakes,
  incidentRelations,
  incidentSignals,
  jobs,
  surfaceBindings,
  withTenant,
} from '@sre/db';

import {
  alertmanagerMonitorKey,
  hash,
  investigationMaterial,
} from '../alertmanager-webhook/normalize';
import { createFixture } from './alertmanager-webhook.fixture';

const __fixture = createFixture();

test('retains named entity and revision changes while suppressing metric-only annotation drift', () => {
  const material = (description: string) =>
    hash(investigationMaterial({ labels: { alertname: 'Latency' }, annotations: { description } }));
  const first = material('deployment checkout-v3 on api-1 has latency 412.5ms');

  expect(material('deployment checkout-v3 on api-1 has latency 901.2ms')).toBe(first);
  expect(material('deployment checkout-v3 on api-2 has latency 901.2ms')).not.toBe(first);
  expect(material('deployment checkout-v4 on api-1 has latency 901.2ms')).not.toBe(first);
  expect(
    material(
      'deployment checkout-v3 on api-1 has latency 412.5ms trace_id=0123456789abcdef0123456789abcdef',
    ),
  ).toBe(
    material(
      'deployment checkout-v3 on api-1 has latency 412.5ms trace_id=fedcba9876543210fedcba9876543210',
    ),
  );
});

test('keeps volatile annotation values ledger-only but reassesses operational meaning', async () => {
  const fingerprint = 'fingerprint-material-policy';
  const startsAt = '2026-08-26T00:30:00Z';
  const changedFingerprint = `${fingerprint}-critical`;
  const changedStartsAt = '2026-08-26T00:32:00Z';
  expect(
    (
      await __fixture.deliver(
        __fixture.payload(fingerprint, startsAt, {
          alertName: 'MaterialPolicyAlert',
          description:
            'Error rate is 5.00% at 2026-08-26T00:30:00Z. https://prometheus.example/graph?t=1',
          monitorId: 'material-policy-alert',
        }),
      )
    ).status,
  ).toBe(200);
  const signalBefore = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) =>
    tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.providerFingerprint, __fixture.providerFingerprint(fingerprint)))
      .limit(1),
  );
  const incidentId = signalBefore[0]!.incidentId;
  const firstSeenAt = signalBefore[0]!.lastSeenAt;

  await new Promise((resolve) => setTimeout(resolve, 5));

  expect(
    (
      await __fixture.deliver(
        __fixture.payload(fingerprint, startsAt, {
          alertName: 'MaterialPolicyAlert',
          description:
            'Error rate is 6.25% at 2026-08-26T00:31:00Z. https://prometheus.example/graph?t=2',
          monitorId: 'material-policy-alert',
        }),
      )
    ).status,
  ).toBe(200);
  const originalSignal = (
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(incidentSignals).where(eq(incidentSignals.incidentId, incidentId)).limit(1),
    )
  )[0]!;
  expect(originalSignal.version).toBe(1);
  expect(originalSignal.lastSeenAt.getTime()).toBeGreaterThan(firstSeenAt.getTime());
  expect(
    (
      await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
    ).filter(
      (job) =>
        job.type === 'signal.reassess' &&
        (job.payload as { incidentId?: string }).incidentId === incidentId,
    ),
  ).toHaveLength(0);

  expect(
    (
      await __fixture.deliver(
        __fixture.payload(changedFingerprint, changedStartsAt, {
          alertName: 'MaterialPolicyAlert',
          description: 'Error rate is 7.50%.',
          severity: 'critical',
          instance: 'checkout-2',
          monitorId: 'material-policy-alert',
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await __fixture.deliver(
        __fixture.payload(changedFingerprint, changedStartsAt, {
          alertName: 'MaterialPolicyAlert',
          description: 'Error rate is 8.00%.',
          severity: 'critical',
          instance: 'checkout-2',
          deploymentRevision: 'release-2026-08-26.2',
          monitorId: 'material-policy-alert',
        }),
      )
    ).status,
  ).toBe(200);

  const changedSignal = (
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx
        .select()
        .from(incidentSignals)
        .where(
          eq(
            incidentSignals.providerFingerprint,
            __fixture.providerFingerprint(changedFingerprint),
          ),
        )
        .limit(1),
    )
  )[0]!;
  expect(changedSignal.incidentId).not.toBe(incidentId);
  expect(changedSignal).toMatchObject({
    version: 2,
    monitorKey: alertmanagerMonitorKey(__fixture.connectorId, {
      alertName: 'MaterialPolicyAlert',
      fingerprint: __fixture.providerFingerprint(changedFingerprint),
      labels: {
        alertname: 'MaterialPolicyAlert',
        service: 'checkout',
        severity: 'critical',
        instance: 'checkout-2',
        sre_monitor_id: 'material-policy-alert',
      },
    }),
  });
  expect(
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(incidentSignals).where(eq(incidentSignals.incidentId, incidentId)),
    ),
  ).toHaveLength(1);
  const incidentJobs = (
    await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
  ).filter(
    (job) => (job.payload as { incidentId?: string }).incidentId === changedSignal.incidentId,
  );
  const reassessments = incidentJobs.filter((job) => job.type === 'signal.reassess');
  expect(reassessments).toHaveLength(1);
  expect(reassessments[0]!.payload).toMatchObject({
    investigationTrigger: { reason: 'material_change', automatic: true },
  });
  expect(incidentJobs.filter((job) => job.type === 'triage')).toHaveLength(1);
});

test('does not correlate label sets without an explicit stable monitor id', async () => {
  const firstFingerprint = 'duplicate-name-rule-a';
  const secondFingerprint = 'duplicate-name-rule-b';
  expect(
    (
      await __fixture.deliver(
        __fixture.payload(firstFingerprint, '2026-08-26T01:00:00Z', {
          alertName: 'SharedAlertName',
          generatorUrl: 'https://prometheus.example/graph?g0.expr=shared_errors',
        }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await __fixture.deliver(
        __fixture.payload(secondFingerprint, '2026-08-26T01:00:01Z', {
          alertName: 'SharedAlertName',
          generatorUrl: 'https://prometheus.example/graph?g0.expr=shared_errors',
        }),
      )
    ).status,
  ).toBe(200);

  const fingerprints = new Set([
    __fixture.providerFingerprint(firstFingerprint),
    __fixture.providerFingerprint(secondFingerprint),
  ]);
  const signals = (
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(incidentSignals),
    )
  ).filter((signal) => fingerprints.has(signal.providerFingerprint ?? ''));
  expect(signals).toHaveLength(2);
  expect(new Set(signals.map((signal) => signal.incidentId)).size).toBe(2);
  expect(new Set(signals.map((signal) => signal.monitorKey)).size).toBe(2);
  const incidentIds = new Set(signals.map((signal) => signal.incidentId));
  const incidentJobs = (
    await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
  ).filter((job) => incidentIds.has((job.payload as { incidentId?: string }).incidentId ?? ''));
  expect(incidentJobs.filter((job) => job.type === 'triage')).toHaveLength(2);
  expect(incidentJobs.filter((job) => job.type === 'signal.reassess')).toHaveLength(0);
});

test('secret-like explicit monitor ids retain distinct opaque correlation identities', async () => {
  const fingerprints = ['secret-monitor-a', 'secret-monitor-b'];
  const monitorIds = ['aB12345678901234567890123456789012', 'cD12345678901234567890123456789012'];
  for (let index = 0; index < fingerprints.length; index++)
    expect(
      (
        await __fixture.deliver(
          __fixture.payload(fingerprints[index]!, `2026-08-26T01:10:0${index}Z`, {
            alertName: 'SecretLikeMonitorIdentity',
            monitorId: monitorIds[index],
          }),
        )
      ).status,
    ).toBe(200);

  const providerFingerprints = fingerprints.map((fingerprint) =>
    __fixture.providerFingerprint(fingerprint),
  );
  const signals = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .select()
      .from(incidentSignals)
      .where(inArray(incidentSignals.providerFingerprint, providerFingerprints)),
  );
  expect(signals).toHaveLength(2);
  expect(new Set(signals.map((signal) => signal.monitorKey)).size).toBe(2);
  expect(new Set(signals.map((signal) => signal.incidentId)).size).toBe(2);
  expect(signals.every((signal) => signal.labels?.sre_monitor_id === '[REDACTED]')).toBe(true);
});

test('keeps concurrent label-set episodes independent for later causal analysis', async () => {
  const fingerprints = ['concurrent-labelset-a', 'concurrent-labelset-b'];
  const responses = await Promise.all(
    fingerprints.map((fingerprint, index) =>
      __fixture.deliver(
        __fixture.payload(fingerprint, `2026-08-26T02:00:0${index}Z`, {
          alertName: 'ConcurrentMaterialAlert',
          severity: index === 0 ? 'warning' : 'critical',
          instance: `checkout-${index + 1}`,
          monitorId: 'concurrent-material-alert',
        }),
      ),
    ),
  );
  expect(responses.map((response) => response.status)).toEqual([200, 200]);

  const providerFingerprints = new Set(
    fingerprints.map((fingerprint) => __fixture.providerFingerprint(fingerprint)),
  );
  const signals = (
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      tx.select().from(incidentSignals),
    )
  ).filter((signal) => providerFingerprints.has(signal.providerFingerprint ?? ''));
  expect(signals).toHaveLength(2);
  expect(new Set(signals.map((signal) => signal.incidentId)).size).toBe(2);
  expect(signals.every((signal) => signal.correlationMethod === 'new_incident')).toBe(true);
  const incidentIds = signals.map((signal) => signal.incidentId);
  const bindings = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx.select().from(surfaceBindings).where(inArray(surfaceBindings.incidentId, incidentIds)),
  );
  expect(bindings).toHaveLength(2);
  expect(bindings.every((binding) => binding.role === 'primary')).toBe(true);
  expect(new Set(bindings.map((binding) => binding.threadId)).size).toBe(2);
  const intakes = await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .select()
      .from(alertEpisodeIntakes)
      .where(inArray(alertEpisodeIntakes.providerFingerprint, [...providerFingerprints])),
  );
  expect(intakes).toHaveLength(2);
  for (const intake of intakes) {
    const binding = bindings.find((candidate) => candidate.id === intake.bindingId);
    expect(binding?.externalId).toBe(`${intake.channel}:${intake.rootMessageId}`);
    expect(binding?.incidentId).toBe(intake.incidentId);
  }
  const incidentJobs = (
    await __fixture.admin.db.select().from(jobs).where(eq(jobs.tenantId, __fixture.tenantId))
  ).filter((job) =>
    incidentIds.includes((job.payload as { incidentId?: string }).incidentId ?? ''),
  );
  expect(incidentJobs.filter((job) => job.type === 'triage')).toHaveLength(2);
  expect(incidentJobs.filter((job) => job.type === 'signal.reassess')).toHaveLength(0);
});

test('opens a new incident and recurrence link when the stable monitor fires another episode', async () => {
  const fingerprints = ['expired-window-a', 'expired-window-b'];
  const providerFingerprints = fingerprints.map((fingerprint) =>
    __fixture.providerFingerprint(fingerprint),
  );
  expect(
    (
      await __fixture.deliver(
        __fixture.payload(fingerprints[0]!, '2026-08-26T03:00:00Z', {
          alertName: 'ExpiredWindowAlert',
          monitorId: 'expired-window-alert',
        }),
      )
    ).status,
  ).toBe(200);
  await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
    tx
      .update(incidentSignals)
      .set({
        correlationWindowStartedAt: new Date(Date.now() - 6 * 60_000),
        correlationWindowExpiresAt: new Date(Date.now() - 60_000),
      })
      .where(eq(incidentSignals.providerFingerprint, providerFingerprints[0]!)),
  );

  expect(
    (
      await __fixture.deliver(
        __fixture.payload(fingerprints[1]!, '2026-08-26T03:00:00Z', {
          alertName: 'ExpiredWindowAlert',
          monitorId: 'expired-window-alert',
        }),
      )
    ).status,
  ).toBe(200);

  const evidence = await withTenant(__fixture.app.db, __fixture.tenantId, async (tx) => {
    const signals = await tx
      .select()
      .from(incidentSignals)
      .where(inArray(incidentSignals.providerFingerprint, providerFingerprints));
    const incidentIds = signals.map((signal) => signal.incidentId);
    return {
      signals,
      bindings: await tx
        .select()
        .from(surfaceBindings)
        .where(inArray(surfaceBindings.incidentId, incidentIds)),
      relations: await tx
        .select()
        .from(incidentRelations)
        .where(
          and(
            inArray(incidentRelations.sourceIncidentId, incidentIds),
            inArray(incidentRelations.targetIncidentId, incidentIds),
          ),
        ),
    };
  });
  expect(new Set(evidence.signals.map((signal) => signal.incidentId)).size).toBe(2);
  expect(
    evidence.signals.find((signal) => signal.providerFingerprint === providerFingerprints[1]),
  ).toMatchObject({
    correlationMethod: 'new_incident',
    correlationFeatures: expect.arrayContaining(['independent_provider_episode']),
  });
  expect(evidence.bindings).toHaveLength(2);
  expect(evidence.bindings.every((binding) => binding.role === 'primary')).toBe(true);
  expect(evidence.relations).toEqual([
    expect.objectContaining({ type: 'recurrence_of', decidedBy: 'system' }),
  ]);
});
