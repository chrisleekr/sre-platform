import { afterAll, describe, expect, test, vi } from 'vitest';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';

import { createIncident, incidents, jobs } from '@sre/db';

import { IncidentUnavailableError, Queue, type JobHandler, type StuckJobInfo } from '../queue';

import { createFixture } from './queue.fixture';

const __fixture = createFixture();

// the archived-incident fence and coalescing for the two generation job types that share
// the runbook stream. `postmortem.generate` is a human command against an incident, so it is refused on
// an archived incident exactly like `runbook.generate`. `assessment.grade` is not: it is enqueued by
// publishing a postmortem, and grading never depends on archive state (only the moved-incident check
// fences it), so a published postmortem on a since-archived incident still gets its grade.
describe('postmortem.generate and assessment.grade at enqueue', () => {
  const nonTerminal = async (type: string, incidentId: string) =>
    __fixture.db.db
      .select()
      .from(jobs)
      .where(
        sql`type = ${type} and payload->>'incidentId' = ${incidentId} and status in ('queued','processing')`,
      );

  const enqueue = (type: 'postmortem.generate' | 'assessment.grade', incidentId: string) =>
    __fixture.q.enqueue({
      tenantId: __fixture.tenant,
      type,
      payload:
        type === 'postmortem.generate'
          ? { incidentId, trigger: 'slow_resolution', requestedByUserId: null }
          : { incidentId, runId: randomUUID() },
    });

  afterAll(async () => {
    await __fixture.db.db
      .delete(jobs)
      .where(
        sql`type in ('postmortem.generate', 'assessment.grade') and tenant_id = ${__fixture.tenant}`,
      );
  });

  test('a deleted incident cannot enqueue postmortem generation, and no durable row is written', async () => {
    const incidentId = (
      await createIncident(__fixture.db.db, __fixture.tenant, {
        fingerprint: randomUUID(),
        alertSource: 'slack',
        service: 'deleted-postmortem',
        severity: 'sev3',
      })
    ).id;
    await __fixture.db.db
      .update(incidents)
      .set({ archivedAt: new Date() })
      .where(eq(incidents.id, incidentId));

    await expect(enqueue('postmortem.generate', incidentId)).rejects.toBeInstanceOf(
      IncidentUnavailableError,
    );
    expect(
      await __fixture.db.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(sql`type = 'postmortem.generate' and payload->>'incidentId' = ${incidentId}`),
    ).toEqual([]);

    // The grade of an already-published postmortem is not a command against the incident: the
    // archived fence does not apply, and the durable row lands.
    const gradeId = await enqueue('assessment.grade', incidentId);
    expect(await nonTerminal('assessment.grade', incidentId)).toEqual([
      expect.objectContaining({ id: gradeId, status: 'queued' }),
    ]);
  });

  test('a double-click while the first postmortem job is queued coalesces onto it', async () => {
    const incidentId = randomUUID();
    const id1 = await enqueue('postmortem.generate', incidentId);
    const id2 = await enqueue('postmortem.generate', incidentId);

    expect(id2).toBe(id1);
    expect(await nonTerminal('postmortem.generate', incidentId)).toHaveLength(1);
  });
});

describe('per-attempt processing deadline', () => {
  const type = `deadline-${__fixture.SUFFIX}`;
  const streamKeys: string[] = [];

  const makeDeadlineQueue = async () => {
    const stream = `${__fixture.STREAM}:deadline:${randomUUID().slice(0, 8)}`;
    const deadStream = `${stream}:dead`;
    const onStuck = vi.fn((_info: StuckJobInfo) => undefined);
    const queue = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream,
      group: 'workers',
      maxAttempts: 3,
      maxProcessingMs: 150,
      stuckGraceMs: 150,
      onStuck,
    });
    await queue.ensureGroup();
    streamKeys.push(stream, deadStream);
    return { queue, deadStream, onStuck };
  };

  afterAll(async () => {
    await __fixture.redis.del(...streamKeys);
    await __fixture.db.db
      .delete(jobs)
      .where(sql`type = ${type} and tenant_id = ${__fixture.tenant}`);
  });

  test('a handler that obeys the deadline requeues once, then dead-letters', async () => {
    const { queue, deadStream, onStuck } = await makeDeadlineQueue();
    const jobId = await queue.enqueue({ tenantId: __fixture.tenant, type, payload: {} });
    let runs = 0;
    const handler: JobHandler = async (_job, ctx) => {
      runs += 1;
      await new Promise<void>((resolve) => {
        if (ctx.signal.aborted) {
          resolve();
          return;
        }
        ctx.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw ctx.signal.reason;
    };

    await queue.process('deadline-a1', handler, { idleMs: 50, count: 1 });
    let row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(row.status).toBe('queued');
    expect(row.lastError).toContain('processing ceiling');

    await queue.process('deadline-a2', handler, { idleMs: 50, count: 1 });
    row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(row.status).toBe('dead');
    expect(await __fixture.redis.xlen(deadStream)).toBe(1);
    expect(runs).toBe(2);
    expect(onStuck).not.toHaveBeenCalled();
  });

  test('a stuck handler is requeued without letting process return early', async () => {
    const { queue, onStuck } = await makeDeadlineQueue();
    const jobId = await queue.enqueue({ tenantId: __fixture.tenant, type, payload: {} });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processing = queue.process(
      'deadline-b',
      async () => {
        markStarted();
        await gate;
      },
      { idleMs: 50, count: 1 },
    );
    let settled = false;
    void processing.then(() => {
      settled = true;
    });
    await started;

    await vi.waitFor(() => expect(onStuck).toHaveBeenCalledTimes(1), { timeout: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);
    expect(onStuck).toHaveBeenCalledWith(
      expect.objectContaining({ jobId, tenantId: __fixture.tenant, type, attempts: 1 }),
    );
    let row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(row.status).toBe('queued');

    release();
    await expect(processing).resolves.toBe(1);
    row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(row.status).toBe('queued');
    expect(onStuck).toHaveBeenCalledTimes(1);
  });

  test('a queue without onStuck holds the lease and logs instead of requeuing', async () => {
    const stream = `${__fixture.STREAM}:deadline:${randomUUID().slice(0, 8)}`;
    const deadStream = `${stream}:dead`;
    const queue = new Queue(__fixture.db.db, __fixture.redis, {
      stream,
      deadStream,
      group: 'workers',
      maxAttempts: 3,
      maxProcessingMs: 150,
      stuckGraceMs: 150,
    });
    await queue.ensureGroup();
    streamKeys.push(stream, deadStream);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const jobId = await queue.enqueue({ tenantId: __fixture.tenant, type, payload: {} });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const processing = queue.process(
        'deadline-no-recycler',
        async () => {
          markStarted();
          await gate;
        },
        { idleMs: 50, count: 1 },
      );
      let settled = false;
      void processing.then(() => {
        settled = true;
      });
      await started;

      const matchingWarnings = () =>
        warn.mock.calls.filter(([entry]) => {
          if (typeof entry !== 'string') return false;
          try {
            const parsed = JSON.parse(entry) as { msg?: unknown };
            return parsed.msg === 'handler ignored deadline; no recycler configured, holding lease';
          } catch {
            return false;
          }
        });
      await vi.waitFor(() => expect(matchingWarnings()).toHaveLength(1), { timeout: 5000 });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      let row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
      expect(row.status).toBe('processing');

      release();
      await expect(processing).resolves.toBe(1);
      row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
      expect(row.status).toBe('done');

      expect(matchingWarnings()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('a handler that finishes before the deadline completes normally', async () => {
    const { queue, onStuck } = await makeDeadlineQueue();
    const jobId = await queue.enqueue({ tenantId: __fixture.tenant, type, payload: {} });

    await queue.process(
      'deadline-c',
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      { idleMs: 50, count: 1 },
    );

    const row = (await __fixture.db.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
    expect(row.status).toBe('done');
    expect(onStuck).not.toHaveBeenCalled();
  });

  test('rejects a non-positive processing ceiling', () => {
    expect(() => new Queue(__fixture.db.db, __fixture.redis, { maxProcessingMs: 0 })).toThrow(
      RangeError,
    );
  });
});
