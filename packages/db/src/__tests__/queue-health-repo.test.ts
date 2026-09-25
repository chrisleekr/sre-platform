import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  DEAD_JOB_ERROR_MAX,
  createIncident,
  incidents,
  jobs,
  listDeadJobs,
  makeDb,
  readQueueHealth,
  tenants,
  type DbHandle,
  type DeadJobCursor,
} from '../index';

// jobs is outside RLS, so these tests are the only proof that the explicit tenant filter holds.
let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let incidentA: string;
let incidentB: string;

const NOW = new Date('2026-09-20T12:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * 60_000);

type JobSeed = Partial<typeof jobs.$inferInsert> & { tenantId: string; status: string };
const seed = (rows: JobSeed[]) =>
  admin.db.insert(jobs).values(rows.map((row) => ({ type: 'triage', stream: 'test', ...row })));

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'Queue health A' },
    { id: tenantB, name: 'Queue health B' },
  ]);
  const incident = (tenantId: string, title: string) =>
    createIncident(app.db, tenantId, {
      fingerprint: randomUUID(),
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
      title,
    });
  incidentA = (await incident(tenantA, 'Checkout errors')).id;
  incidentB = (await incident(tenantB, 'Tenant B secret incident')).id;
});

afterAll(async () => {
  await admin.db.delete(jobs).where(inArray(jobs.tenantId, [tenantA, tenantB]));
  await admin.db.delete(incidents).where(inArray(incidents.tenantId, [tenantA, tenantB]));
  await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
  await admin.close();
  await app.close();
});

describe('readQueueHealth', () => {
  test('counts live and dead work per type, excludes done, and ignores other tenants', async () => {
    await seed([
      { tenantId: tenantA, type: 'triage', status: 'queued', availableAt: at(30) },
      { tenantId: tenantA, type: 'triage', status: 'queued', availableAt: at(5) },
      // Delayed work is queued but not yet waiting, so it must not set the oldest due time.
      { tenantId: tenantA, type: 'triage', status: 'queued', availableAt: at(-60) },
      { tenantId: tenantA, type: 'triage', status: 'processing' },
      { tenantId: tenantA, type: 'resume', status: 'dead' },
      { tenantId: tenantA, type: 'resume', status: 'done' },
      { tenantId: tenantA, type: 'poll', status: 'done' },
      { tenantId: tenantB, type: 'triage', status: 'queued', availableAt: at(600) },
      { tenantId: tenantB, type: 'tenant-b-only', status: 'dead' },
    ]);

    const health = await readQueueHealth(app.db, tenantA, NOW);

    expect(health.asOf).toBe(NOW.toISOString());
    expect(health.types).toEqual([
      { type: 'resume', queued: 0, processing: 0, dead: 1, oldestDueAt: null },
      {
        type: 'triage',
        queued: 3,
        processing: 1,
        dead: 0,
        oldestDueAt: at(30).toISOString(),
      },
    ]);
  });
});

describe('listDeadJobs', () => {
  test('pages newest first without gaps or repeats, and never returns another tenant', async () => {
    const tenant = randomUUID();
    await admin.db.insert(tenants).values({ id: tenant, name: 'Queue paging' });
    try {
      // Two rows share one updated_at so the id tiebreak is exercised across a page boundary.
      const tied = at(10);
      await seed([
        { tenantId: tenant, status: 'dead', updatedAt: at(1) },
        { tenantId: tenant, status: 'dead', updatedAt: tied },
        { tenantId: tenant, status: 'dead', updatedAt: tied },
        { tenantId: tenant, status: 'dead', updatedAt: at(20) },
        { tenantId: tenant, status: 'dead', updatedAt: at(30) },
        { tenantId: tenant, status: 'done', updatedAt: at(2) },
        { tenantId: tenantB, status: 'dead', updatedAt: at(3) },
      ]);
      const expected = await admin.db
        .select({ id: jobs.id, updatedAt: jobs.updatedAt })
        .from(jobs)
        .where(and(eq(jobs.tenantId, tenant), eq(jobs.status, 'dead')));
      // Postgres orders uuids bytewise, which matches lowercase hex text order.
      const deadIds = expected
        .sort((l, r) => r.updatedAt.getTime() - l.updatedAt.getTime() || (l.id < r.id ? 1 : -1))
        .map((row) => row.id);

      const seen: string[] = [];
      let cursor: DeadJobCursor | undefined;
      let pages = 0;
      do {
        const page = await listDeadJobs(app.db, tenant, {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.jobs.map((job) => job.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(pages).toBe(3);
      expect(seen).toEqual(deadIds);
    } finally {
      await admin.db.delete(jobs).where(inArray(jobs.tenantId, [tenant]));
      await admin.db.delete(tenants).where(inArray(tenants.id, [tenant]));
    }
  });

  test('links only same-tenant incidents, scrubs and shortens the error, and omits the payload', async () => {
    const secret = 'Authorization: Bearer abcDEF123ghiJKL456mnoPQR789stuVWX0';
    await seed([
      {
        tenantId: tenantA,
        type: 'linked',
        status: 'dead',
        attempts: 3,
        payload: { incidentId: incidentA, note: 'payload-only-marker' },
        lastError: `${secret}\n${'x'.repeat(1_000)}`,
        updatedAt: at(1),
      },
      {
        tenantId: tenantA,
        type: 'foreign',
        status: 'dead',
        // A payload naming another tenant's incident must not reveal its title or link to it.
        payload: { incidentId: incidentB },
        updatedAt: at(2),
      },
      {
        tenantId: tenantA,
        type: 'malformed',
        status: 'dead',
        payload: { incidentId: 'not-a-uuid' },
        updatedAt: at(3),
      },
      {
        tenantId: tenantB,
        type: 'tenant-b-dead',
        status: 'dead',
        payload: { incidentId: incidentB },
      },
    ]);

    const page = await listDeadJobs(app.db, tenantA, { limit: 50 });
    const byType = new Map(page.jobs.map((job) => [job.type, job]));

    expect(byType.get('linked')).toMatchObject({
      attempts: 3,
      incidentId: incidentA,
      incidentTitle: 'Checkout errors',
    });
    const lastError = byType.get('linked')?.lastError ?? '';
    expect(lastError).not.toContain('abcDEF123');
    expect(lastError).toContain('Authorization: [REDACTED]');
    expect([...lastError]).toHaveLength(DEAD_JOB_ERROR_MAX);
    expect(byType.get('foreign')).toMatchObject({ incidentId: null, incidentTitle: null });
    expect(byType.get('malformed')).toMatchObject({ incidentId: null, lastError: null });
    expect(JSON.stringify(page)).not.toContain('payload-only-marker');
    expect(JSON.stringify(page)).not.toContain('Tenant B secret incident');
    expect(byType.has('tenant-b-dead')).toBe(false);
  });
});
