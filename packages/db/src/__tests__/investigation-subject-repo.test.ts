import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import {
  createIncident,
  getInvestigationSubject,
  insertInvestigationSubjectTx,
  listMissingSubjectSyncCandidates,
} from '../index';
import { incidents, investigationSubjects, jobs, tenants } from '../schema';
import { makeDb, type DbHandle } from '../client';
import { withTenant } from '../rls';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'Subject A' },
    { id: tenantB, name: 'Subject B' },
  ]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(investigationSubjects).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('investigation subject tenancy', () => {
  test('persists only bounded typed provenance and is invisible across tenant RLS', async () => {
    const incident = await createIncident(app.db, tenantA, {
      fingerprint: `subject-${randomUUID()}`,
      alertSource: 'platform',
      service: 'checkout',
      severity: 'sev3',
    });
    await withTenant(app.db, tenantA, (tx) =>
      insertInvestigationSubjectTx(tx, tenantA, incident.id, {
        kind: 'topology_service',
        sourceId: 'topology',
        subjectId: 'checkout',
        fingerprint: `platform:topology_service:checkout`,
        sourcePath: '/topology',
        state: 'firing',
        summary: 'One runtime pod needs attention',
        snapshot: { pods: 3, unhealthyPods: 1 },
        contentHash: 'a'.repeat(64),
        observedAt: new Date(),
        syncEnabled: true,
      }),
    );

    expect(await getInvestigationSubject(app.db, tenantA, incident.id)).toMatchObject({
      kind: 'topology_service',
      sourceId: 'topology',
      subjectId: 'checkout',
    });
    expect(await getInvestigationSubject(app.db, tenantB, incident.id)).toBeNull();

    expect(await listMissingSubjectSyncCandidates(app.db, tenantA)).toContain(incident.id);
    expect(await listMissingSubjectSyncCandidates(app.db, tenantB)).not.toContain(incident.id);
    const [syncJob] = await admin.db
      .insert(jobs)
      .values({
        tenantId: tenantA,
        type: 'subject.sync',
        payload: { incidentId: incident.id },
        status: 'queued',
        stream: 'test:subject-sync-recovery',
      })
      .returning();
    expect(await listMissingSubjectSyncCandidates(app.db, tenantA)).not.toContain(incident.id);
    await admin.db.update(jobs).set({ status: 'dead' }).where(eq(jobs.id, syncJob!.id));
    expect(await listMissingSubjectSyncCandidates(app.db, tenantA)).toContain(incident.id);
    await admin.db
      .update(incidents)
      .set({ status: 'resolved' })
      .where(eq(incidents.id, incident.id));
    expect(await listMissingSubjectSyncCandidates(app.db, tenantA)).not.toContain(incident.id);
  });
});
