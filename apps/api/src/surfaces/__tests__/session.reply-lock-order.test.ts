import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import { incidents, lockResponseGroupWorkTx } from '@sre/db';
import { openIncidentSession } from '../session';
import { createFixture } from './session.fixture';

const __fixture = createFixture();

test('a dashboard reply takes response-group work locks before its archive-check row lock', async () => {
  const incidentId = await __fixture.freshIncident();
  const { ticket } = await __fixture.mintTicket({ tenantId: __fixture.tenantA, sub: 'u' });
  const session = await openIncidentSession(__fixture.deps, {
    incidentId,
    ticket,
    sink: __fixture.collector().sink,
  });
  expect(session).not.toBeNull();

  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer: group work locks first, then the incident row.
  const holder: Promise<unknown> = __fixture.admin.db.transaction(async (tx) => {
    await lockResponseGroupWorkTx(tx, __fixture.tenantA, incidentId);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .for('update');
  });
  await holderHasGroupLock;

  const content = `dashboard reply ${randomUUID()}`;
  const replied = session!.adapter.ingest({ content });

  // Without an observed advisory wait the holder never contended, so the outcome proves nothing.
  try {
    await vi.waitFor(
      async () => {
        const waiting = await __fixture.admin.db.execute(
          sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`,
        );
        if (waiting.length === 0) throw new Error('reply is not waiting on an advisory lock');
      },
      { timeout: 5_000, interval: 50 },
    );
  } finally {
    releaseHolder();
  }

  // An inverted order deadlocks here and Postgres aborts one side with 40P01.
  const [holderOutcome, replyOutcome] = await Promise.allSettled([holder, replied]);
  expect(holderOutcome.status === 'rejected' ? holderOutcome.reason : 'ok').toBe('ok');
  expect(replyOutcome.status === 'rejected' ? replyOutcome.reason : 'ok').toBe('ok');
  const history = await __fixture.hub.history(__fixture.tenantA, incidentId);
  expect(history.filter((message) => message.content === content)).toHaveLength(1);
  await session!.close();
}, 20_000);
