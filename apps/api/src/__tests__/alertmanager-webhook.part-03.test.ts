import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
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
