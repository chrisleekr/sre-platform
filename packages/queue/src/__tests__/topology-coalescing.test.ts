import { expect, test, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { jobs } from '@sre/db';
import { requeueUnlessSuperseded } from '../queue/coalescing';
import { createFixture } from './queue.fixture';

// The real type is required: the coalescing index is a partial index on type = 'topology.discover'.
const TYPE = 'topology.discover';
const fixture = createFixture();

async function rowsFor(connectorId: string) {
  return fixture.db.db
    .select({
      id: jobs.id,
      status: jobs.status,
      lastError: jobs.lastError,
      payload: jobs.payload,
    })
    .from(jobs)
    .where(
      and(
        eq(jobs.tenantId, fixture.tenant),
        eq(jobs.type, TYPE),
        sql`payload->>'connectorId' = ${connectorId}`,
      ),
    );
}

test('one queued pass per connector; a pass arriving mid-run queues exactly one successor', async () => {
  const connector = randomUUID();
  const other = randomUUID();
  const first = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector },
  });
  const continuation = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector, pageCount: 1, collections: ['dashboards'] },
  });
  expect(continuation).toBe(first);
  const otherConnector = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: other },
  });
  expect(otherConnector).not.toBe(first);

  const successors: string[] = [];
  const handle = vi.fn(async (job: { id: string }) => {
    if (job.id !== first) return;
    for (let i = 0; i < 2; i++)
      successors.push(
        await fixture.q.enqueue({
          tenantId: fixture.tenant,
          type: TYPE,
          payload: { connectorId: connector },
        }),
      );
  });
  await fixture.q.process('worker', handle, { idleMs: 0, count: 10 });

  expect(successors[0]).not.toBe(first);
  expect(successors[1]).toBe(successors[0]);
  const rows = await rowsFor(connector);
  expect(rows.map((row) => [row.id, row.status]).sort()).toEqual(
    [
      [first, 'done'],
      [successors[0], 'queued'],
    ].sort(),
  );
  // The absorbed continuation left the queued full pass unnarrowed.
  expect(rows.find((row) => row.id === first)?.payload).toEqual({ connectorId: connector });
  expect(rows.find((row) => row.id === successors[0])?.payload).toEqual({ connectorId: connector });
});

test('a full pass arriving onto a queued page continuation widens it to every collection', async () => {
  const connector = randomUUID();
  const continuation = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector, pageCount: 2, collections: ['dashboards'] },
  });
  const full = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector },
  });
  expect(full).toBe(continuation);
  const rows = await rowsFor(connector);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'queued', payload: { connectorId: connector } });
});

test('a failed pass retires instead of requeueing when a successor already holds its slot', async () => {
  const connector = randomUUID();
  const failing = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector },
  });
  let successor = '';
  const handle = vi.fn(async (job: { id: string }) => {
    if (job.id !== failing) return;
    successor = await fixture.q.enqueue({
      tenantId: fixture.tenant,
      type: TYPE,
      payload: { connectorId: connector },
    });
    throw new Error('persist failed');
  });
  await fixture.q.process('worker', handle, { idleMs: 0, count: 10 });

  const rows = await rowsFor(connector);
  expect(rows.find((row) => row.id === failing)).toMatchObject({
    status: 'done',
    lastError: 'persist failed',
  });
  expect(rows.find((row) => row.id === successor)?.status).toBe('queued');
});

test('reconcile retires a stranded pass with a queued successor and requeues one without', async () => {
  const shadowed = randomUUID();
  const alone = randomUUID();
  const stale = sql`now() - interval '5 minutes'`;
  const [stranded] = await fixture.db.db
    .insert(jobs)
    .values({
      tenantId: fixture.tenant,
      type: TYPE,
      payload: { connectorId: shadowed },
      status: 'processing',
      attempts: 1,
      stream: fixture.STREAM,
      updatedAt: stale,
    })
    .returning({ id: jobs.id });
  const successor = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: shadowed },
  });
  const [orphan] = await fixture.db.db
    .insert(jobs)
    .values({
      tenantId: fixture.tenant,
      type: TYPE,
      payload: { connectorId: alone },
      status: 'processing',
      attempts: 1,
      stream: fixture.STREAM,
      updatedAt: stale,
    })
    .returning({ id: jobs.id });

  await fixture.q.reconcile();

  const shadowedRows = await rowsFor(shadowed);
  expect(shadowedRows.find((row) => row.id === stranded!.id)?.status).toBe('done');
  expect(shadowedRows.find((row) => row.id === successor)?.status).toBe('queued');
  const [requeued] = await fixture.db.db.select().from(jobs).where(eq(jobs.id, orphan!.id));
  expect(requeued).toMatchObject({ status: 'queued', attempts: 1 });
  expect(requeued?.streamId).not.toBeNull();
});

test('requeueUnlessSuperseded retires a topology pass whose successor holds the slot', async () => {
  const connector = randomUUID();
  const [running] = await fixture.db.db
    .insert(jobs)
    .values({
      tenantId: fixture.tenant,
      type: TYPE,
      payload: { connectorId: connector },
      status: 'processing',
      attempts: 1,
      stream: fixture.STREAM,
    })
    .returning({ id: jobs.id });
  const successor = await fixture.q.enqueue({
    tenantId: fixture.tenant,
    type: TYPE,
    payload: { connectorId: connector },
  });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const requeued = await requeueUnlessSuperseded(
      fixture.db.db,
      { id: running!.id, type: TYPE },
      and(eq(jobs.id, running!.id), eq(jobs.status, 'processing')),
      { lastError: 'boom' },
    );
    expect(requeued).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('retired superseded job after failure'),
    );
  } finally {
    warn.mockRestore();
  }
  const rows = await rowsFor(connector);
  expect(rows.find((row) => row.id === running!.id)).toMatchObject({
    status: 'done',
    lastError: 'boom',
  });
  expect(rows.find((row) => row.id === successor)).toMatchObject({
    status: 'queued',
    lastError: null,
  });
});

test('requeueUnlessSuperseded rethrows a unique violation from any other coalescing index', async () => {
  const incidentId = randomUUID();
  const [queued, running] = await fixture.db.db
    .insert(jobs)
    .values(
      (['queued', 'processing'] as const).map((status) => ({
        tenantId: fixture.tenant,
        type: 'resume',
        payload: { incidentId },
        status,
        stream: fixture.STREAM,
      })),
    )
    .returning({ id: jobs.id });
  try {
    await expect(
      requeueUnlessSuperseded(
        fixture.db.db,
        { id: running!.id, type: 'resume' },
        and(eq(jobs.id, running!.id), eq(jobs.status, 'processing')),
        { lastError: 'boom' },
      ),
    ).rejects.toThrow();
    const [row] = await fixture.db.db.select().from(jobs).where(eq(jobs.id, running!.id));
    expect(row?.status).toBe('processing');
  } finally {
    await fixture.db.db.delete(jobs).where(inArray(jobs.id, [queued!.id, running!.id]));
  }
});
