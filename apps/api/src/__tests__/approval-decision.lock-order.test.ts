import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { approvals, createApproval, createIncident, incidents, lockIncidentWorkTx } from '@sre/db';
import { applyApprovalDecision } from '../approval-decision';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();

test('an approval takes response-group work locks before the incident row lock', async () => {
  const incident = await createIncident(fixture.app.db, fixture.tenantC, {
    fingerprint: `approval-lock-order-${randomUUID()}`,
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev3',
  });
  const approval = await createApproval(fixture.app.db, fixture.tenantC, {
    incidentId: incident.id,
    actionId: randomUUID(),
    prompt: 'Apply change?',
    options: [{ id: 'approve', label: 'Approve' }],
  });
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasGroupLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer or connector reconcile: group work lock first, then the incident row.
  const holder: Promise<unknown> = fixture.admin.db.transaction(async (tx) => {
    await lockIncidentWorkTx(tx, fixture.tenantC, [incident.id]);
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

  const decided = applyApprovalDecision(
    {
      adminDb: fixture.admin.db,
      appDb: fixture.app.db,
      hub: fixture.hub,
      queue: fixture.declarationQueue,
    },
    {
      tenantId: fixture.tenantC,
      approvalId: approval.row.id,
      optionId: 'approve',
      decidedBy: 'lock-order-responder',
      originSurface: 'dashboard',
    },
  );
  // Wait until the decision blocks on the held advisory lock, whatever it already holds.
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

  // An inverted order deadlocks here and Postgres aborts one side.
  const [holderOutcome, decisionOutcome] = await Promise.allSettled([holder, decided]);
  expect(holderOutcome.status).toBe('fulfilled');
  expect(decisionOutcome).toEqual({
    status: 'fulfilled',
    value: { status: 'decided', label: 'Approve' },
  });
  const [row] = await fixture.admin.db
    .select({ decision: approvals.decision })
    .from(approvals)
    .where(eq(approvals.id, approval.row.id));
  expect(row?.decision).toBe('approve');
}, 20_000);
