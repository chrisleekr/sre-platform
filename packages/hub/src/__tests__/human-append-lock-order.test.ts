import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  createIncident,
  incidentMessages,
  incidents,
  lockIncidentWorkTx,
  lockResponseGroupWorkTx,
  withTenant,
} from '@sre/db';
import { createFixture } from './hub.fixture';

const fixture = createFixture();

test('a human append takes response-group work locks before the incident row lock', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantA, {
    fingerprint: `human-append-lock-order-${randomUUID()}`,
    alertSource: 'slack',
    service: 'checkout',
    severity: 'sev3',
  });
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer: group work locks first, then the incident row.
  const holder: Promise<unknown> = fixture.admin.db.transaction(async (tx) => {
    await lockResponseGroupWorkTx(tx, fixture.tenantA, incident.id);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, incident.id))
      .for('update');
  });
  await holderHasGroupLock;

  // Mirrors a human reply: the append, then the resume enqueue's incident-work fence.
  const content = `human reply ${randomUUID()}`;
  const replied = withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    const message = await fixture.hub.appendTx(tx, fixture.tenantA, incident.id, {
      author: 'human',
      content,
      originSurface: 'dashboard',
    });
    await lockIncidentWorkTx(tx, fixture.tenantA, [incident.id]);
    return message;
  });
  let blocked = false;
  for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
    const waiting = await fixture.admin.db.execute(
      sql`select 1 from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory'`,
    );
    blocked = waiting.length > 0;
    if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  releaseHolder();
  // Without an observed block the holder never contended, so the outcome below would prove nothing.
  expect(blocked).toBe(true);

  // An inverted order deadlocks here and Postgres aborts one side with 40P01.
  const [holderOutcome, replyOutcome] = await Promise.allSettled([holder, replied]);
  expect(holderOutcome.status === 'rejected' ? holderOutcome.reason : 'ok').toBe('ok');
  expect(replyOutcome.status === 'rejected' ? replyOutcome.reason : 'ok').toBe('ok');
  const rows = await fixture.admin.db
    .select({ id: incidentMessages.id })
    .from(incidentMessages)
    .where(eq(incidentMessages.content, content));
  expect(rows).toHaveLength(1);
}, 20_000);
