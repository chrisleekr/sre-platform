import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  createIncident,
  makeDb,
  recordIncidentRelation,
  recordUnrelatedIncidents,
  type DbHandle,
} from '../index';
import { lockIncidentWorkTx } from '../incident-relation-repo/core';
import { incidentMessages, incidentRelations, incidents, jobs, tenants } from '../schema';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Relation lock order tenant' });
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(eq(jobs.tenantId, tenantId));
    await admin.db.delete(incidentMessages).where(eq(incidentMessages.tenantId, tenantId));
    await admin.db.delete(incidentRelations).where(eq(incidentRelations.tenantId, tenantId));
    await admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

const newIncident = (title: string) =>
  createIncident(app.db, tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'prometheus',
    service: 'checkout',
    severity: 'sev2',
    title,
    investigationStatus: 'assessed',
  });

test('an unrelated correction takes every response-group work lock before the pair row locks', async () => {
  const root = await newIncident('Root cause');
  const child = await newIncident('Child symptom');
  const third = await newIncident('Third symptom');
  for (const source of [child, third])
    await recordIncidentRelation(app.db, tenantId, {
      sourceIncidentId: source.id,
      targetIncidentId: root.id,
      type: 'caused_by',
      rationale: 'The symptom follows the root failure.',
      evidence: ['responder:lock-order'],
      decidedBy: 'human',
      decidedByUserId: randomUUID(),
    });
  const [appRow] = await app.db.execute<{ role: string }>(sql`select current_user as role`);
  const appRole = appRow!.role;
  let releaseHolder!: () => void;
  const holderMayFinish = new Promise<void>((resolve) => (releaseHolder = resolve));
  let holderLocked!: () => void;
  const holderHasWorkLock = new Promise<void>((resolve) => (holderLocked = resolve));

  // Mirrors a signal writer on the third group member: work lock first, then an incident row.
  const holder: Promise<unknown> = admin.db.transaction(async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [third.id]);
    holderLocked();
    await holderMayFinish;
    await tx.execute(sql`set local lock_timeout = '5s'`);
    await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, root.id))
      .for('update');
  });
  await holderHasWorkLock;

  const correction = recordUnrelatedIncidents(app.db, tenantId, {
    sourceIncidentId: child.id,
    targetIncidentId: root.id,
    rationale: 'The child failed independently of the root.',
    evidence: ['trace:separate'],
    decidedByUserId: randomUUID(),
  });
  // The correction must block on the held advisory lock, or the ordering is never exercised.
  // Scoped to the app role because the holder runs as admin and cannot be the waiter.
  await vi.waitFor(
    async () => {
      const waiting = await admin.db.execute(
        sql`select pid from pg_stat_activity
            where wait_event_type = 'Lock' and wait_event = 'advisory'
              and datname = current_database() and usename = ${appRole}`,
      );
      expect(waiting.length).toBeGreaterThan(0);
    },
    { timeout: 5_000, interval: 50 },
  );
  releaseHolder();

  // Row-locking the pair before the third member's work lock deadlocks here.
  const [holderOutcome, correctionOutcome] = await Promise.allSettled([holder, correction]);
  expect(holderOutcome.status).toBe('fulfilled');
  expect(correctionOutcome).toEqual({
    status: 'fulfilled',
    value: expect.objectContaining({ type: 'unrelated' }),
  });
}, 20_000);
