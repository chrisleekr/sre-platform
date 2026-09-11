import { describe, expect, test } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, inArray, sql } from 'drizzle-orm';

import { beginRecoveryVerification, incidents, jobs } from '@sre/db';

import { LockContentionError, Queue, RetryableError, pruneTerminalJobs } from '../queue';

import { createFixture } from './queue.fixture';

const __fixture = createFixture();

describe('Valkey Streams queue', () => {
  test.each([2, 3])(
    'a material update during recovery attempt %i preserves its budget and cannot cross a terminal fence',
    async (attempt) => {
      const incidentId = randomUUID();
      await __fixture.db.db.insert(incidents).values({
        id: incidentId,
        tenantId: __fixture.tenant,
        fingerprint: `recovery-in-flight-${attempt}-${incidentId}`,
        alertSource: 'alertmanager',
        service: 'checkout',
        severity: 'sev3',
        investigationStatus: 'gathering',
        recoveryState: 'verifying',
        recoveryAttempt: attempt,
        recoveryMaxChecks: 3,
      });
      await __fixture.db.db.insert(jobs).values({
        tenantId: __fixture.tenant,
        type: 'recovery.verify',
        status: 'processing',
        stream: __fixture.STREAM,
        payload: {
          incidentId,
          lifecycleVersion: 0,
          signalFence: 'signal-a:2:resolved',
          attempt,
          maxChecks: 3,
          restoreInvestigationStatus: 'assessed',
        },
      });

      const replacement = await __fixture.db.db.transaction((tx) =>
        __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:3:resolved'),
      );

      expect(replacement.jobId).toBeTruthy();
      expect(
        (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, replacement.jobId!)))[0]
          ?.payload,
      ).toEqual({
        incidentId,
        lifecycleVersion: 0,
        signalFence: 'signal-a:3:resolved',
        attempt,
        maxChecks: 3,
        restoreInvestigationStatus: 'assessed',
        investigationTrigger: {
          reason: 'recovery_verification',
          automatic: true,
          monitorKey: null,
        },
      });

      await __fixture.db.db
        .update(incidents)
        .set({ investigationStatus: 'assessed', recoveryState: 'not_verified' })
        .where(eq(incidents.id, incidentId));
      await expect(
        beginRecoveryVerification(
          __fixture.db.db,
          __fixture.tenant,
          replacement.jobId!,
          incidentId,
          0,
          'signal-a:3:resolved',
          { attempt, maxChecks: 3 },
        ),
      ).resolves.toBeNull();
      expect(
        (
          await __fixture.db.db
            .select({
              investigationStatus: incidents.investigationStatus,
              recoveryState: incidents.recoveryState,
              recoveryAttempt: incidents.recoveryAttempt,
              recoveryMaxChecks: incidents.recoveryMaxChecks,
            })
            .from(incidents)
            .where(eq(incidents.id, incidentId))
        )[0],
      ).toEqual({
        investigationStatus: 'assessed',
        recoveryState: 'not_verified',
        recoveryAttempt: attempt,
        recoveryMaxChecks: 3,
      });
    },
  );

  test('coalesces queued recovery verification onto the newest fences', async () => {
    const incidentId = randomUUID();
    const first = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 1, 'signal-a:2:resolved'),
    );
    expect(first.jobId).toBeTruthy();

    const coalesced = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 3, 'signal-a:4:resolved'),
    );
    expect(coalesced.jobId).toBeNull();
    const queued = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, first.jobId!)))[0]!;
    expect(queued.payload).toEqual({
      incidentId,
      lifecycleVersion: 3,
      signalFence: 'signal-a:4:resolved',
      investigationTrigger: {
        reason: 'recovery_verification',
        automatic: true,
        monitorKey: null,
      },
    });

    await __fixture.db.db
      .update(jobs)
      .set({ status: 'processing' })
      .where(eq(jobs.id, first.jobId!));
    const successor = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 5, 'signal-a:6:resolved'),
    );
    expect(successor.jobId).toBeTruthy();
    expect(successor.jobId).not.toBe(first.jobId);
    await __fixture.db.db
      .delete(jobs)
      .where(sql`tenant_id = ${__fixture.tenant} and payload->>'incidentId' = ${incidentId}`);
  });

  test('keeps a model-scheduled recovery durable but undispatched until its due time', async () => {
    const incidentId = randomUUID();
    const future = new Date(Date.now() + 10 * 60_000);
    const scheduled = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:2:resolved', {
        attempt: 2,
        maxChecks: 3,
        availableAt: future,
        scheduleReason: 'Wait for the deployment rollout to settle.',
      }),
    );
    expect(scheduled.jobId).toBeTruthy();
    await __fixture.db.db
      .delete(jobs)
      .where(
        sql`tenant_id = ${__fixture.tenant} and id <> ${scheduled.jobId!} and stream = ${__fixture.STREAM}`,
      );

    const before = await __fixture.redis.xlen(__fixture.STREAM);
    await __fixture.q.publishJob(scheduled.jobId!);
    expect(await __fixture.redis.xlen(__fixture.STREAM)).toBe(before);
    expect(await __fixture.q.dispatchDue()).toBe(0);

    // Even a forged/early stream pointer cannot bypass the Postgres due-time gate.
    await __fixture.redis.xadd(__fixture.STREAM, '*', 'jobId', scheduled.jobId!);
    const early: string[] = [];
    await __fixture.q.process('early-scheduled-recovery', async (job) => {
      early.push(job.id);
    });
    expect(early).toEqual([]);
    expect(
      (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, scheduled.jobId!)))[0],
    ).toMatchObject({
      status: 'queued',
      attempts: 0,
    });

    await __fixture.db.db
      .update(jobs)
      .set({ availableAt: new Date(0) })
      .where(eq(jobs.id, scheduled.jobId!));
    expect(await __fixture.q.dispatchDue()).toBe(1);

    const handled: string[] = [];
    await __fixture.q.process('scheduled-recovery', async (job) => {
      handled.push(job.id);
    });
    expect(handled).toEqual([scheduled.jobId]);
    expect(
      (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, scheduled.jobId!)))[0],
    ).toMatchObject({
      status: 'done',
      payload: {
        incidentId,
        lifecycleVersion: 0,
        signalFence: 'signal-a:2:resolved',
        attempt: 2,
        maxChecks: 3,
        scheduleReason: 'Wait for the deployment rollout to settle.',
      },
    });
  });

  test('a repeated resolved observation cannot reset a scheduled recovery budget', async () => {
    const incidentId = randomUUID();
    await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:2:resolved', {
        attempt: 2,
        maxChecks: 3,
        availableAt: new Date(Date.now() + 10 * 60_000),
        scheduleReason: 'Wait for the deployment rollout to settle.',
      }),
    );

    await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:3:resolved'),
    );

    const row = (
      await __fixture.db.db
        .select()
        .from(jobs)
        .where(sql`tenant_id = ${__fixture.tenant} and payload->>'incidentId' = ${incidentId}`)
    )[0]!;
    expect(row.payload).toMatchObject({
      lifecycleVersion: 0,
      signalFence: 'signal-a:3:resolved',
      attempt: 2,
      maxChecks: 3,
      scheduleReason: 'Wait for the deployment rollout to settle.',
    });
    expect(row.availableAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('does not restart automatic recovery after the cycle needs human attention', async () => {
    const incidentId = randomUUID();
    await __fixture.db.db.insert(incidents).values({
      id: incidentId,
      tenantId: __fixture.tenant,
      fingerprint: `recovery-terminal-${incidentId}`,
      alertSource: 'alertmanager',
      service: 'checkout',
      severity: 'sev3',
      investigationStatus: 'assessed',
      recoveryState: 'not_verified',
      recoveryAttempt: 3,
      recoveryMaxChecks: 3,
    });

    const result = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:5:resolved'),
    );

    expect(result.jobId).toBeNull();
    expect(
      await __fixture.db.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(sql`tenant_id = ${__fixture.tenant} and payload->>'incidentId' = ${incidentId}`),
    ).toEqual([]);
  });

  test('recovery queued during unrelated gathering captures the settled progress at execution', async () => {
    const incidentId = randomUUID();
    await __fixture.db.db.insert(incidents).values({
      id: incidentId,
      tenantId: __fixture.tenant,
      fingerprint: `recovery-settled-${incidentId}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
      investigationStatus: 'gathering',
    });
    const recovery = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 0, 'signal-a:2:resolved'),
    );
    const queued = (
      await __fixture.db.db.select().from(jobs).where(eq(jobs.id, recovery.jobId!))
    )[0]!;
    expect(queued.payload).toEqual({
      incidentId,
      lifecycleVersion: 0,
      signalFence: 'signal-a:2:resolved',
      investigationTrigger: {
        reason: 'recovery_verification',
        automatic: true,
        monitorKey: null,
      },
    });

    await __fixture.db.db
      .update(incidents)
      .set({ investigationStatus: 'assessed' })
      .where(eq(incidents.id, incidentId));
    expect(
      await beginRecoveryVerification(
        __fixture.db.db,
        __fixture.tenant,
        recovery.jobId!,
        incidentId,
        0,
        'signal-a:2:resolved',
      ),
    ).toBeNull();
    expect(
      (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, recovery.jobId!)))[0]?.payload,
    ).toEqual({
      incidentId,
      lifecycleVersion: 0,
      signalFence: 'signal-a:2:resolved',
      restoreInvestigationStatus: 'assessed',
      investigationTrigger: {
        reason: 'recovery_verification',
        automatic: true,
        monitorKey: null,
      },
    });
    expect(
      (
        await __fixture.db.db
          .select({ investigationStatus: incidents.investigationStatus })
          .from(incidents)
          .where(eq(incidents.id, incidentId))
      )[0]?.investigationStatus,
    ).toBe('assessed');
    await __fixture.db.db.delete(jobs).where(eq(jobs.id, recovery.jobId!));
  });

  test('reconcile retires a stranded recovery predecessor when a newer successor is queued', async () => {
    const incidentId = randomUUID();
    await __fixture.db.db.insert(incidents).values({
      id: incidentId,
      tenantId: __fixture.tenant,
      fingerprint: `recovery-handoff-${incidentId}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
      investigationStatus: 'assessed',
    });
    const predecessor = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 1, 'signal-a:2:resolved'),
    );
    await __fixture.db.db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({
          status: 'processing',
          attempts: 1,
          updatedAt: sql`now() - interval '5 minutes'`,
        })
        .where(eq(jobs.id, predecessor.jobId!));
      await tx
        .update(incidents)
        .set({ investigationStatus: 'gathering' })
        .where(eq(incidents.id, incidentId));
    });
    const successor = await __fixture.db.db.transaction((tx) =>
      __fixture.q.insertRecoveryTx(tx, __fixture.tenant, incidentId, 3, 'signal-a:4:resolved'),
    );

    await __fixture.db.db
      .update(incidents)
      .set({ status: 'resolved', lifecycleVersion: 1 })
      .where(eq(incidents.id, incidentId));
    expect(
      await beginRecoveryVerification(
        __fixture.db.db,
        __fixture.tenant,
        successor.jobId!,
        incidentId,
        3,
        'signal-a:4:resolved',
      ),
    ).toBeNull();
    expect(
      (
        await __fixture.db.db
          .select({ investigationStatus: incidents.investigationStatus })
          .from(incidents)
          .where(eq(incidents.id, incidentId))
      )[0]?.investigationStatus,
    ).toBe('assessed');

    expect(await __fixture.q.reconcile(60_000)).toBeGreaterThanOrEqual(1);

    const rows = await __fixture.db.db
      .select({ id: jobs.id, status: jobs.status, payload: jobs.payload })
      .from(jobs)
      .where(inArray(jobs.id, [predecessor.jobId!, successor.jobId!]));
    expect(rows.find((row) => row.id === predecessor.jobId)).toMatchObject({ status: 'done' });
    expect(rows.find((row) => row.id === successor.jobId)).toMatchObject({
      status: 'queued',
      payload: {
        incidentId,
        lifecycleVersion: 3,
        signalFence: 'signal-a:4:resolved',
        restoreInvestigationStatus: 'assessed',
      },
    });
    await __fixture.db.db
      .delete(jobs)
      .where(sql`tenant_id = ${__fixture.tenant} and payload->>'incidentId' = ${incidentId}`);
  });

  test('prunes only old terminal jobs across streams and is idempotent', async () => {
    // Keep this global delete outside the age range used by fixtures in parallel test files.
    const retentionSec = 10 * 365 * 24 * 60 * 60;
    const old = new Date(Date.now() - 2 * retentionSec * 1_000);
    const recent = new Date(Date.now() - (retentionSec * 1_000) / 2);
    const rows = [
      { id: randomUUID(), status: 'done', stream: `${__fixture.STREAM}:prune-a`, updatedAt: old },
      { id: randomUUID(), status: 'dead', stream: `${__fixture.STREAM}:prune-b`, updatedAt: old },
      {
        id: randomUUID(),
        status: 'done',
        stream: `${__fixture.STREAM}:prune-a`,
        updatedAt: recent,
      },
      {
        id: randomUUID(),
        status: 'dead',
        stream: `${__fixture.STREAM}:prune-b`,
        updatedAt: recent,
      },
      { id: randomUUID(), status: 'queued', stream: `${__fixture.STREAM}:prune-a`, updatedAt: old },
      {
        id: randomUUID(),
        status: 'processing',
        stream: `${__fixture.STREAM}:prune-b`,
        updatedAt: old,
      },
    ] as const;
    await __fixture.db.db.insert(jobs).values(
      rows.map((row) => ({
        ...row,
        tenantId: __fixture.tenant,
        type: __fixture.TYPE,
        payload: {},
      })),
    );

    expect(await pruneTerminalJobs(__fixture.db.db, retentionSec)).toBe(2);

    const remaining = await __fixture.db.db
      .select({ id: jobs.id, status: jobs.status })
      .from(jobs)
      .where(
        inArray(
          jobs.id,
          rows.map((row) => row.id),
        ),
      );
    expect(remaining).toHaveLength(4);
    expect(remaining.map(({ id }) => id).sort()).toEqual(
      rows
        .slice(2)
        .map(({ id }) => id)
        .sort(),
    );
    expect(remaining.map(({ status }) => status).sort()).toEqual([
      'dead',
      'done',
      'processing',
      'queued',
    ]);
    expect(await pruneTerminalJobs(__fixture.db.db, retentionSec)).toBe(0);
  });

  test('enqueue writes the Postgres row then the stream; process runs the handler once and acks', async () => {
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: { n: 1 },
    });
    const before = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0];
    expect(before!.streamId).toBeTruthy();

    const handled: string[] = [];
    await __fixture.q.process('c1', async (job) => {
      expect(job.createdAt).toEqual(before!.createdAt);
      handled.push(job.id);
    });
    expect(handled).toEqual([id]);
    expect((await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!.status).toBe(
      'done',
    );

    // Re-processing finds nothing new and never re-runs the acked job.
    const again = await __fixture.q.process('c1', async () => {
      throw new Error('should not run');
    });
    expect(again).toBe(0);
  });

  test('a failing job retries via reclaim, then lands in the DLQ after maxAttempts', async () => {
    const id = await __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type: __fixture.TYPE,
      payload: {},
    });
    const fail = async () => {
      throw new Error('boom');
    };
    // maxAttempts = 3 → three failing passes (idleMs 0 reclaims the pending entry each time).
    await __fixture.q.process('c1', fail, { idleMs: 0 });
    await __fixture.q.process('c1', fail, { idleMs: 0 });
    await __fixture.q.process('c1', fail, { idleMs: 0 });

    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(row.lastError).toBe('boom');
    expect(await __fixture.redis.xlen(__fixture.DEAD)).toBeGreaterThanOrEqual(1);
  });

  test('a RetryableError re-queues past maxAttempts and only dead-letters at retryableMaxAttempts', async () => {
    const stream = `test:jobs:retry:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    // Normal errors dead-letter at 2; retryable ones (provider outage) get a higher ceiling of 3.
    const rq = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream: dead,
      group: 'workers',
      maxAttempts: 2,
      retryableMaxAttempts: 3,
    });
    await rq.ensureGroup();
    const id = await rq.enqueue({ tenantId: __fixture.tenant, type: __fixture.TYPE, payload: {} });
    const retryable = async () => {
      throw new RetryableError('provider unavailable');
    };

    await rq.process('c1', retryable, { idleMs: 0 });
    // After maxAttempts (2) a normal error would be dead; a RetryableError is still queued.
    await rq.process('c1', retryable, { idleMs: 0 });
    let row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(2);
    expect(row.lastError).toBe('provider unavailable');

    // The higher ceiling still bounds a poison job: dead-letters at retryableMaxAttempts (3).
    await rq.process('c1', retryable, { idleMs: 0 });
    row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(3);
    expect(await __fixture.redis.xlen(dead)).toBeGreaterThanOrEqual(1);

    await __fixture.redis.del(stream, dead);
  });

  test('a LockContentionError gets its own ceiling, separate from the provider-outage retryableMaxAttempts', async () => {
    const stream = `test:jobs:lock:${randomUUID().slice(0, 8)}`;
    const dead = `${stream}:dead`;
    // Provider-outage ceiling is 3; lock-contention gets a higher, separate ceiling of 5.
    const lq = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream: dead,
      group: 'workers',
      maxAttempts: 2,
      retryableMaxAttempts: 3,
      lockContentionMaxAttempts: 5,
    });
    await lq.ensureGroup();
    const id = await lq.enqueue({ tenantId: __fixture.tenant, type: __fixture.TYPE, payload: {} });
    const contended = async () => {
      throw new LockContentionError('engine busy for this incident; redelivering');
    };

    // At the provider-outage ceiling (3) a plain RetryableError would be dead; a LockContentionError
    // is still queued because it has its own higher ceiling; sharing the ceiling would kill it at 3.
    await lq.process('c1', contended, { idleMs: 0 });
    await lq.process('c1', contended, { idleMs: 0 });
    await lq.process('c1', contended, { idleMs: 0 });
    let row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('queued');
    expect(row.attempts).toBe(3);

    // Its own ceiling still bounds a poison job: dead-letters at lockContentionMaxAttempts (5).
    await lq.process('c1', contended, { idleMs: 0 });
    await lq.process('c1', contended, { idleMs: 0 });
    row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, id)))[0]!;
    expect(row.status).toBe('dead');
    expect(row.attempts).toBe(5);
    expect(await __fixture.redis.xlen(dead)).toBeGreaterThanOrEqual(1);

    await __fixture.redis.del(stream, dead);
  });
});
