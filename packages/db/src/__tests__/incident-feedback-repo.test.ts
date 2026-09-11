import { seedMembership } from '../test-support';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  createIncident,
  incidentFeedback,
  incidents,
  listIncidentFeedback,
  listLatestIncidentFeedback,
  makeDb,
  memberships,
  recordIncidentFeedback,
  recordIncidentFeedbackTx,
  tenants,
  users,
  withTenant,
  type DbHandle,
} from '../index';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;
let incidentId: string;

async function expectConstraint(operation: Promise<unknown>, name: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    const cause = error && typeof error === 'object' && 'cause' in error ? error.cause : error;
    expect(String(cause)).toContain(name);
    return;
  }
  throw new Error(`operation unexpectedly succeeded without ${name}`);
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'Feedback tenant A' },
    { id: tenantB, name: 'Feedback tenant B' },
  ]);
  userA = await seedMembership(
    admin.db,
    { issuer: 'feedback-test', subject: randomUUID() },
    tenantA,
  );
  userB = await seedMembership(
    admin.db,
    { issuer: 'feedback-test', subject: randomUUID() },
    tenantB,
  );
  incidentId = (
    await createIncident(app.db, tenantA, {
      fingerprint: randomUUID(),
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
});

afterAll(async () => {
  if (admin) {
    await admin.db
      .delete(incidentFeedback)
      .where(inArray(incidentFeedback.tenantId, [tenantA, tenantB]));
    await admin.db.delete(incidents).where(inArray(incidents.tenantId, [tenantA, tenantB]));
    await admin.db.delete(memberships).where(inArray(memberships.tenantId, [tenantA, tenantB]));
    await admin.db.delete(users).where(inArray(users.id, [userA, userB]));
    await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await admin.close();
  }
  if (app) await app.close();
});

test('stores attributed feedback under tenant RLS and rejects a foreign member', async () => {
  const feedback = await recordIncidentFeedback(app.db, tenantA, incidentId, {
    targetType: 'finding',
    targetId: randomUUID(),
    decision: 'correct',
    rationale: 'The trace points at the pool rather than the deployment.',
    correction: { replacement: 'Connection pool saturation caused the errors.' },
    createdByUserId: userA,
  });
  expect(feedback).toMatchObject({
    incidentId,
    decision: 'correct',
    createdByUserId: userA,
  });
  expect(feedback).not.toHaveProperty('tenantId');
  expect(feedback.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  await expect(listIncidentFeedback(app.db, tenantA, incidentId)).resolves.toMatchObject([
    { id: feedback.id, decision: 'correct' },
  ]);
  await expect(listIncidentFeedback(app.db, tenantB, incidentId)).resolves.toEqual([]);

  await expectConstraint(
    recordIncidentFeedback(app.db, tenantA, incidentId, {
      targetType: 'noise',
      targetId: randomUUID(),
      decision: 'noise',
      rationale: 'Foreign attribution must fail.',
      createdByUserId: userB,
    }),
    'incident_feedback_membership_fk',
  );
});

test('database vocabulary rejects a decision for the wrong target type', async () => {
  await expectConstraint(
    admin.db.insert(incidentFeedback).values({
      tenantId: tenantA,
      incidentId,
      targetType: 'finding',
      targetId: randomUUID(),
      decision: 'noise',
      rationale: 'Invalid pair.',
      createdByUserId: userA,
    }),
    'incident_feedback_target_decision_vocabulary',
  );
  expect(
    await admin.db
      .select({ id: incidentFeedback.id })
      .from(incidentFeedback)
      .where(eq(incidentFeedback.tenantId, tenantA)),
  ).toHaveLength(1);
});

test('workspace feedback keeps only the newest verdict for each target', async () => {
  const targetId = randomUUID();
  const initial = await recordIncidentFeedback(app.db, tenantA, incidentId, {
    targetType: 'finding',
    targetId,
    decision: 'confirm',
    rationale: 'Initial evidence agreed.',
    createdByUserId: userA,
  });
  const later = await recordIncidentFeedback(app.db, tenantA, incidentId, {
    targetType: 'finding',
    targetId,
    decision: 'correct',
    rationale: 'A later trace contradicted the finding.',
    correction: { replacement: 'The corrected finding.' },
    createdByUserId: userA,
  });
  const sharedCreatedAt = new Date('2026-09-01T00:00:00.000Z');
  await admin.db
    .update(incidentFeedback)
    .set({ id: 'ffffffff-ffff-4fff-bfff-fffffffffff1', createdAt: sharedCreatedAt })
    .where(eq(incidentFeedback.id, initial.id));
  await admin.db
    .update(incidentFeedback)
    .set({ id: '00000000-0000-4000-8000-000000000001', createdAt: sharedCreatedAt })
    .where(eq(incidentFeedback.id, later.id));
  const feedback = await listLatestIncidentFeedback(app.db, tenantA, incidentId);
  expect(feedback.filter((item) => item.targetId === targetId)).toEqual([
    expect.objectContaining({ decision: 'correct' }),
  ]);
});

test('serializes concurrent verdict revisions for the same target', async () => {
  const targetId = randomUUID();
  let releaseFirst!: () => void;
  const release = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let firstWritten!: () => void;
  const written = new Promise<void>((resolve) => {
    firstWritten = resolve;
  });
  let firstBackendPid: number | undefined;
  let secondBackendPid: number | undefined;
  const first = withTenant(app.db, tenantA, async (tx) => {
    const backend = await tx.execute(sql`select pg_backend_pid()::int as pid`);
    firstBackendPid = Number((backend as unknown as Array<{ pid: number }>)[0]!.pid);
    const feedback = await recordIncidentFeedbackTx(tx, tenantA, incidentId, {
      targetType: 'finding',
      targetId,
      decision: 'confirm',
      rationale: 'The first responder confirmed the evidence.',
      createdByUserId: userA,
    });
    firstWritten();
    await release;
    return feedback;
  });
  await written;
  const second = withTenant(app.db, tenantA, async (tx) => {
    const backend = await tx.execute(sql`select pg_backend_pid()::int as pid`);
    secondBackendPid = Number((backend as unknown as Array<{ pid: number }>)[0]!.pid);
    return recordIncidentFeedbackTx(tx, tenantA, incidentId, {
      targetType: 'finding',
      targetId,
      decision: 'correct',
      rationale: 'The second responder corrected the evidence.',
      correction: { replacement: 'The concurrent correction.' },
      createdByUserId: userA,
    });
  });
  let waitFailure: unknown;
  try {
    await expect
      .poll(async () => {
        const blockers = await admin.sql<Array<{ blockers: number[] }>>`
          SELECT pg_blocking_pids(${secondBackendPid!}) AS blockers
        `;
        return blockers[0]?.blockers ?? [];
      })
      .toContain(firstBackendPid);
  } catch (error) {
    waitFailure = error;
  } finally {
    releaseFirst();
  }
  const records = await Promise.all([first, second]);
  if (waitFailure) throw waitFailure;
  const revisions = await admin.db
    .select({ revision: incidentFeedback.revision })
    .from(incidentFeedback)
    .where(eq(incidentFeedback.targetId, targetId))
    .orderBy(incidentFeedback.revision);
  expect(records).toHaveLength(2);
  expect(revisions).toEqual([{ revision: 1 }, { revision: 2 }]);
  await expect(listLatestIncidentFeedback(app.db, tenantA, incidentId)).resolves.toContainEqual(
    expect.objectContaining({ targetId, decision: 'correct' }),
  );
  await expectConstraint(
    admin.db.insert(incidentFeedback).values({
      tenantId: tenantA,
      incidentId,
      targetType: 'finding',
      targetId,
      revision: 2,
      decision: 'confirm',
      rationale: 'A duplicate target revision must fail.',
      createdByUserId: userA,
    }),
    'incident_feedback_target_revision_uq',
  );
});
