import { afterEach, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import {
  incidentMessages,
  incidentRelations,
  incidentSignals,
  investigationSubjects,
  jobs,
  transitionIncidentTx,
  withTenant,
} from '@sre/db';

import {
  openIncidentWorkspace,
  platformSubjectFingerprint,
  platformSubjectSignalExternalId,
} from '@sre/alerts';

import { RetryableError } from '@sre/queue';

import { createFixture } from './subject-sync-worker.fixture';

const __fixture = createFixture();

describe('subject.sync worker', () => {
  afterEach(() => vi.restoreAllMocks());

  test('repairs a stale canonical signal and active legacy projection without another LLM turn', async () => {
    const incident = await __fixture.opened();
    const [subject, canonical] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`incident_id = ${incident.incidentId}`)
        .then((rows) => rows[0]!),
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`)
        .then((rows) => rows[0]!),
    ]);
    const resolvedHash = `resolved-${randomUUID()}`;
    const lastSyncedAt = new Date(Date.now() - 10 * 60_000);
    await __fixture.admin.db
      .update(investigationSubjects)
      .set({
        currentState: 'resolved',
        currentSummary: 'Runtime recovered',
        currentSnapshot: { pods: 3, unhealthyPods: 0 },
        currentHash: resolvedHash,
        lastSyncedAt,
      })
      .where(eq(investigationSubjects.id, subject.id));
    await __fixture.admin.db.insert(incidentSignals).values({
      tenantId: __fixture.tenantId,
      incidentId: incident.incidentId,
      provider: 'platform',
      materialHash: 'legacy-firing',
      surface: 'dashboard',
      channel: subject.sourcePath,
      externalMessageId: `${subject.fingerprint}:${incident.incidentId}`,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Legacy runtime failure',
      contentHash: 'legacy-firing',
      lastEventKey: `legacy:${randomUUID()}`,
      lastEventAt: lastSyncedAt,
      firstSeenAt: lastSyncedAt,
      lastSeenAt: lastSyncedAt,
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Runtime recovered',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: resolvedHash,
        observedAt: new Date(),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [signals, recovery, reassessment] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.state === 'resolved')).toBe(true);
    expect(signals.find((signal) => signal.id === canonical.id)).toMatchObject({
      materialHash: resolvedHash,
      version: 2,
    });
    expect(recovery).toHaveLength(1);
    expect(reassessment).toHaveLength(0);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('subject.signal_projection_repaired'),
    );
    expect(warning.mock.calls.flat().join(' ')).not.toContain('Legacy runtime failure');
    warning.mockClear();

    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Runtime recovered',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: resolvedHash,
        observedAt: new Date(),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });
    const [replayedSignals, replayedRecovery] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(replayedSignals.map((signal) => signal.version).sort()).toEqual(
      signals.map((signal) => signal.version).sort(),
    );
    expect(replayedRecovery).toHaveLength(1);
    expect(warning).not.toHaveBeenCalled();
  });

  test('reports and idempotently repairs canonical-only projection drift', async () => {
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
    const observedAt = new Date();
    await Promise.all([
      __fixture.admin.db
        .update(investigationSubjects)
        .set({ lastSyncedAt: new Date(observedAt.getTime() - 10 * 60_000) })
        .where(eq(investigationSubjects.id, subject.id)),
      __fixture.admin.db
        .update(incidentSignals)
        .set({ state: 'resolved', contentHash: `drift-${randomUUID()}` })
        .where(eq(incidentSignals.id, canonical.id)),
    ]);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const resolve = async () => ({
      state: subject.currentState,
      summary: subject.currentSummary,
      snapshot: subject.currentSnapshot,
      contentHash: subject.currentHash,
      observedAt,
    });

    await __fixture.worker(resolve).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });

    const [repaired] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, canonical.id));
    expect(repaired).toMatchObject({
      state: subject.currentState,
      contentHash: subject.currentHash,
      version: canonical.version + 1,
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('subject.signal_projection_repaired'),
    );
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('"canonicalProjectionChanged":true'),
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('"repairedSignalCount":0'));
    warning.mockClear();

    await __fixture.worker(resolve).handle(__fixture.job(incident.incidentId), {
      signal: new AbortController().signal,
    });

    const [replayed] = await __fixture.admin.db
      .select({ version: incidentSignals.version })
      .from(incidentSignals)
      .where(eq(incidentSignals.id, canonical.id));
    expect(replayed!.version).toBe(repaired!.version);
    expect(warning).not.toHaveBeenCalled();
  });

  test('does not resolve a distinct platform signal merged into the incident', async () => {
    const incident = await __fixture.opened();
    const [subject] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${incident.incidentId}`);
    const observedAt = new Date();
    const resolvedHash = `resolved-${randomUUID()}`;
    await __fixture.admin.db.insert(incidentSignals).values({
      tenantId: __fixture.tenantId,
      incidentId: incident.incidentId,
      provider: 'platform',
      materialHash: 'merged-subject-firing',
      surface: 'dashboard',
      channel: '/topology',
      externalMessageId: `platform:subject-signal:${randomUUID()}`,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Another platform subject is still failing',
      contentHash: 'merged-subject-firing',
      lastEventKey: `merged:${randomUUID()}`,
      lastEventAt: observedAt,
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
    });

    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Primary subject recovered',
        snapshot: { pods: 3, unhealthyPods: 0 },
        contentHash: resolvedHash,
        observedAt: new Date(observedAt.getTime() + 1_000),
      }))
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });

    const [signals, recovery, reassessment] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'recovery.verify' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'signal.reassess' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    expect(
      signals.find(
        (signal) => signal.externalMessageId === `${subject!.fingerprint}:${incident.incidentId}`,
      ),
    ).toBeUndefined();
    expect(signals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'resolved', materialHash: resolvedHash }),
        expect.objectContaining({ state: 'firing', contentHash: 'merged-subject-firing' }),
      ]),
    );
    expect(recovery).toHaveLength(0);
    expect(reassessment).toHaveLength(1);
  });

  test('keeps 500-character subject identities distinct through sync, recovery, and recurrence', async () => {
    const sharedPrefix = `service-${'x'.repeat(491)}`;
    const firstSubjectId = `${sharedPrefix}a`;
    const secondSubjectId = `${sharedPrefix}b`;
    expect(firstSubjectId).toHaveLength(500);
    expect(secondSubjectId).toHaveLength(500);
    const identity = (subjectId: string) => ({
      kind: 'topology_service' as const,
      sourceId: 'topology',
      subjectId,
    });
    const open = (subjectId: string) =>
      openIncidentWorkspace(
        { appDb: __fixture.app.db, queue: __fixture.queue },
        {
          tenantId: __fixture.tenantId,
          source: 'platform',
          service: subjectId,
          severity: 'sev3',
          subject: {
            ...identity(subjectId),
            sourcePath: '/topology',
            state: 'firing',
            summary: 'Runtime needs attention',
            observedAt: new Date(),
            snapshot: { pods: 2, unhealthyPods: 1 },
          },
        },
      );

    const first = await open(firstSubjectId);
    const firstFingerprint = platformSubjectFingerprint(identity(firstSubjectId));
    await __fixture
      .worker(async () => ({
        state: 'resolved',
        summary: 'Runtime recovered',
        snapshot: { pods: 2, unhealthyPods: 0 },
        contentHash: `resolved-${randomUUID()}`,
        observedAt: new Date(Date.now() + 1_000),
      }))
      .handle(__fixture.job(first.incidentId), { signal: new AbortController().signal });

    const [recoveredSignal] = await __fixture.admin.db
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, first.incidentId));
    expect(recoveredSignal).toMatchObject({
      state: 'resolved',
      version: 2,
      externalMessageId: platformSubjectSignalExternalId(firstFingerprint, first.incidentId),
    });

    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      transitionIncidentTx(tx, first.incidentId, 'closed'),
    );
    const recurrence = await open(firstSubjectId);
    const distinct = await open(secondSubjectId);
    expect(new Set([first.incidentId, recurrence.incidentId, distinct.incidentId]).size).toBe(3);

    const [stored, relation] = await Promise.all([
      __fixture.admin.db
        .select({
          incidentId: investigationSubjects.incidentId,
          subjectId: investigationSubjects.subjectId,
          fingerprint: investigationSubjects.fingerprint,
        })
        .from(investigationSubjects)
        .where(sql`incident_id in (${recurrence.incidentId}, ${distinct.incidentId})`),
      __fixture.admin.db
        .select()
        .from(incidentRelations)
        .where(
          sql`source_incident_id = ${recurrence.incidentId} and target_incident_id = ${first.incidentId}`,
        ),
    ]);
    expect(stored).toEqual(
      expect.arrayContaining([
        {
          incidentId: recurrence.incidentId,
          subjectId: firstSubjectId,
          fingerprint: firstFingerprint,
        },
        {
          incidentId: distinct.incidentId,
          subjectId: secondSubjectId,
          fingerprint: platformSubjectFingerprint(identity(secondSubjectId)),
        },
      ]),
    );
    expect(new Set(stored.map((row) => row.fingerprint)).size).toBe(2);
    expect(relation).toHaveLength(1);
    expect(relation[0]).toMatchObject({ type: 'recurrence_of', evidence: [firstFingerprint] });
  });

  test('does not mutate or schedule after the incident closes while its source is resolving', async () => {
    const incident = await __fixture.opened();
    const [subjectBefore] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${incident.incidentId}`);
    const [messagesBefore, jobsBefore] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ]);
    let release!: () => void;
    let started!: () => void;
    const resolving = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resolverStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const handling = __fixture
      .worker(async () => {
        started();
        await resolving;
        return {
          state: 'resolved' as const,
          summary: 'Late recovery',
          snapshot: { pods: 3, unhealthyPods: 0 },
          contentHash: `late-${randomUUID()}`,
          observedAt: new Date(),
        };
      })
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });
    await resolverStarted;
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      transitionIncidentTx(tx, incident.incidentId, 'closed'),
    );
    release();
    await handling;

    const [subjectAfter, messagesAfter, jobsAfter, signals] = await Promise.all([
      __fixture.admin.db
        .select()
        .from(investigationSubjects)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(incidentMessages)
        .where(sql`incident_id = ${incident.incidentId}`),
      __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and payload->>'incidentId' = ${incident.incidentId}`,
        ),
      __fixture.admin.db
        .select()
        .from(incidentSignals)
        .where(sql`incident_id = ${incident.incidentId}`),
    ]);
    expect(subjectAfter[0]).toMatchObject({
      currentHash: subjectBefore!.currentHash,
      syncEnabled: subjectBefore!.syncEnabled,
    });
    expect(messagesAfter).toHaveLength(messagesBefore.length);
    expect(jobsAfter).toHaveLength(jobsBefore.length);
    expect(signals[0]).toMatchObject({ state: 'firing', version: 1 });
  });

  test('retries unavailable source reads without adding conversation or LLM work', async () => {
    const incident = await __fixture.opened();
    const before = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incident.incidentId}`);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      __fixture
        .worker(async () => {
          throw new Error('connector down with glpat-ABCDEF1234567890abcd');
        })
        .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal }),
    ).rejects.toBeInstanceOf(RetryableError);
    const after = await __fixture.admin.db
      .select()
      .from(incidentMessages)
      .where(sql`incident_id = ${incident.incidentId}`);
    expect(after).toHaveLength(before.length);
    expect(warning.mock.calls.flat().join(' ')).not.toContain('glpat-ABCDEF1234567890abcd');
  });

  test('stops synchronization after the incident is terminal', async () => {
    const incident = await __fixture.opened();
    const [claimed] = await __fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenantId} and type = 'subject.sync' and payload->>'incidentId' = ${incident.incidentId}`,
      );
    await __fixture.admin.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(sql`id = ${claimed!.id}`);
    await withTenant(__fixture.app.db, __fixture.tenantId, (tx) =>
      transitionIncidentTx(tx, incident.incidentId, 'closed'),
    );
    let called = false;
    await __fixture
      .worker(async () => {
        called = true;
        throw new Error('must not resolve');
      })
      .handle(__fixture.job(incident.incidentId), { signal: new AbortController().signal });
    const [subject] = await __fixture.admin.db
      .select()
      .from(investigationSubjects)
      .where(sql`incident_id = ${incident.incidentId}`);
    expect(called).toBe(false);
    expect(subject!.syncEnabled).toBe(true);
    expect(
      await __fixture.admin.db
        .select()
        .from(jobs)
        .where(
          sql`tenant_id = ${__fixture.tenantId} and type = 'subject.sync' and status = 'queued' and payload->>'incidentId' = ${incident.incidentId}`,
        ),
    ).toHaveLength(0);
  });
});
