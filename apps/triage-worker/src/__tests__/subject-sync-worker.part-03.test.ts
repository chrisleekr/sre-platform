import { afterEach, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { incidentMessages, incidentSignals, investigationSubjects, jobs } from '@sre/db';

import { createFixture } from './subject-sync-worker.fixture';

const __fixture = createFixture();

async function insertLegacySignal(incidentId: string) {
  const [subject] = await __fixture.admin.db
    .select()
    .from(investigationSubjects)
    .where(eq(investigationSubjects.incidentId, incidentId));
  const observedAt = new Date();
  const rows = await __fixture.admin.db
    .insert(incidentSignals)
    .values({
      tenantId: __fixture.tenantId,
      incidentId,
      provider: 'platform',
      materialHash: 'legacy-firing',
      surface: 'dashboard',
      channel: subject!.sourcePath,
      externalMessageId: `${subject!.fingerprint}:${incidentId}`,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Legacy runtime failure',
      contentHash: 'legacy-firing',
      lastEventKey: `legacy:${randomUUID()}`,
      lastEventAt: observedAt,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    })
    .returning();
  return rows[0]!;
}

async function persistedIncidentState(incidentId: string) {
  const [subjects, signals, messages, work] = await Promise.all([
    __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(eq(investigationSubjects.incidentId, incidentId)),
    __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incidentId)),
    __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(eq(incidentMessages.incidentId, incidentId)),
    __fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`tenant_id = ${__fixture.tenantId} and payload->>'incidentId' = ${incidentId}`),
  ]);
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((left, right) => left.id.localeCompare(right.id));
  return {
    subjects: byId(subjects),
    signals: byId(signals),
    messages: byId(messages),
    work: byId(work),
  };
}

describe('subject.sync transaction failures', () => {
  afterEach(() => vi.restoreAllMocks());

  test('rolls back subject, signal, message, and work changes when recovery scheduling fails', async () => {
    const incident = await __fixture.opened();
    await insertLegacySignal(incident.incidentId);
    const before = await persistedIncidentState(incident.incidentId);
    vi.spyOn(__fixture.queue, 'insertRecoveryTx').mockRejectedValueOnce(
      new Error('recovery scheduling failed'),
    );

    await expect(
      __fixture
        .worker(async () => ({
          state: 'resolved',
          summary: 'Runtime recovered',
          snapshot: { pods: 3, unhealthyPods: 0 },
          contentHash: `resolved-${randomUUID()}`,
          observedAt: new Date(Date.now() + 1_000),
        }))
        .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal }),
    ).rejects.toThrow('recovery scheduling failed');

    expect(await persistedIncidentState(incident.incidentId)).toEqual(before);
  });

  test('rolls back subject, signal, message, and work changes when reassessment scheduling fails', async () => {
    const incident = await __fixture.opened();
    await insertLegacySignal(incident.incidentId);
    const before = await persistedIncidentState(incident.incidentId);
    vi.spyOn(__fixture.queue, 'insertReassessmentTx').mockRejectedValueOnce(
      new Error('reassessment scheduling failed'),
    );

    await expect(
      __fixture
        .worker(async () => ({
          state: 'firing',
          summary: 'Runtime failure changed materially',
          snapshot: { pods: 3, unhealthyPods: 2 },
          contentHash: `changed-${randomUUID()}`,
          observedAt: new Date(Date.now() + 1_000),
        }))
        .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal }),
    ).rejects.toThrow('reassessment scheduling failed');

    expect(await persistedIncidentState(incident.incidentId)).toEqual(before);
  });

  test('reassesses a repair-only legacy resolution when another signal remains active', async () => {
    const incident = await __fixture.opened();
    const [subject, canonical] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(eq(investigationSubjects.incidentId, incident.incidentId))
        .then((rows) => rows[0]!),
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.incidentId))
        .then((rows) => rows[0]!),
    ]);
    const resolvedAt = new Date();
    const resolvedHash = `resolved-${randomUUID()}`;
    await Promise.all([
      __fixture.admin.db
        .update(investigationSubjects)
        .set({
          currentState: 'resolved',
          currentSummary: 'Runtime recovered',
          currentSnapshot: { pods: 3, unhealthyPods: 0 },
          currentHash: resolvedHash,
          lastSyncedAt: resolvedAt,
        })
        .where(eq(investigationSubjects.id, subject.id)),
      __fixture.admin.db
        .update(incidentSignals)
        .set({
          state: 'resolved',
          lastEventType: 'resolved',
          summary: 'Runtime recovered',
          contentHash: resolvedHash,
          materialHash: resolvedHash,
          lastEventKey: `resolved:${randomUUID()}`,
          lastEventAt: resolvedAt,
          lastSeenAt: resolvedAt,
          resolvedAt,
          version: 2,
        })
        .where(eq(incidentSignals.id, canonical.id)),
    ]);
    const legacy = await insertLegacySignal(incident.incidentId);
    const [distinct] = await __fixture.admin.db
      .insert(incidentSignals)
      .values({
        tenantId: __fixture.tenantId,
        incidentId: incident.incidentId,
        provider: 'platform',
        materialHash: 'distinct-firing',
        surface: 'dashboard',
        channel: '/topology',
        externalMessageId: `platform:subject-signal:${randomUUID()}`,
        state: 'firing',
        lastEventType: 'opened',
        summary: 'Another subject is still failing',
        contentHash: 'distinct-firing',
        lastEventKey: `distinct:${randomUUID()}`,
        lastEventAt: resolvedAt,
        firstSeenAt: resolvedAt,
        lastSeenAt: resolvedAt,
      })
      .returning();

    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Runtime recovered',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: resolvedHash,
        observedAt: new Date(resolvedAt.getTime() + 1_000),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [signals, reassessments] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.incidentId, incident.incidentId)),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signals.find((signal) => signal.id === legacy.id)).toMatchObject({
      state: 'resolved',
      version: 2,
    });
    expect(signals.find((signal) => signal.id === distinct!.id)).toMatchObject({
      state: 'firing',
      version: 1,
    });
    expect(reassessments).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          signalChanges: expect.arrayContaining([
            expect.objectContaining({ signalId: legacy.id, signalVersion: 2 }),
          ]),
        }),
      }),
    ]);
  });
});
