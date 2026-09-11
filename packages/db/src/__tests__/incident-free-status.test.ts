import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, test } from 'vitest';
import { incidents, tenants } from '../index';
import * as incidentRepo from '../incident-repo';
import { createFixture } from './incident-repo.fixture';

const fixture = createFixture();

type IncidentFreeStatus = {
  state: 'running' | 'paused' | 'never_observed';
  asOf: Date;
  startedAt: Date | null;
  qualifyingActiveCount: number;
  scope: { severities: ['sev1', 'sev2'] };
  lastIncident: { id: string; title: string | null; severity: string } | null;
};

const readIncidentFreeStatus = (tenantId: string): Promise<IncidentFreeStatus> =>
  (
    incidentRepo as unknown as {
      readIncidentFreeStatus: (
        db: typeof fixture.app.db,
        tenantId: string,
      ) => Promise<IncidentFreeStatus>;
    }
  ).readIncidentFreeStatus(fixture.app.db, tenantId);

async function withTenantRows(
  name: string,
  run: (tenantId: string) => Promise<void>,
): Promise<void> {
  const tenantId = randomUUID();
  await fixture.admin.db.insert(tenants).values({ id: tenantId, name });
  try {
    await run(tenantId);
  } finally {
    await fixture.admin.db.delete(incidents).where(eq(incidents.tenantId, tenantId));
    await fixture.admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  }
}

async function seedIncident(
  tenantId: string,
  input: {
    severity: 'sev1' | 'sev2' | 'sev3';
    status: 'open' | 'mitigated' | 'resolved' | 'closed';
    createdAt: string;
    resolvedAt?: string;
    closedAt?: string;
    archivedAt?: string;
    title?: string;
  },
): Promise<string> {
  const id = randomUUID();
  await fixture.admin.db.insert(incidents).values({
    id,
    tenantId,
    fingerprint: `incident-free-${id}`,
    alertSource: 'datadog',
    service: 'checkout',
    severity: input.severity,
    status: input.status,
    title: input.title,
    createdAt: new Date(input.createdAt),
    updatedAt: new Date(input.createdAt),
    resolvedAt: input.resolvedAt ? new Date(input.resolvedAt) : null,
    closedAt: input.closedAt ? new Date(input.closedAt) : null,
    archivedAt: input.archivedAt ? new Date(input.archivedAt) : null,
  });
  return id;
}

describe('readIncidentFreeStatus', () => {
  test('health checks do not pause the incident-free clock', async () => {
    await withTenantRows('health-check-clock', async (tenantId) => {
      const input = {
        fingerprint: randomUUID(),
        service: 'checkout',
        severity: 'sev2',
        alertSource: 'manual',
        purpose: 'health_check' as const,
      };
      await incidentRepo.createIncident(fixture.app.db, tenantId, input);
      expect(await readIncidentFreeStatus(tenantId)).toMatchObject({
        state: 'never_observed',
        qualifyingActiveCount: 0,
        lastIncident: null,
      });
    });
  });

  test('C1 returns a running streak from the latest resolvedAt and uses closedAt only as fallback', async () => {
    await withTenantRows('incident-free-running', async (tenantId) => {
      const fallbackId = await seedIncident(tenantId, {
        severity: 'sev2',
        status: 'closed',
        createdAt: '2026-09-02T09:00:00.000Z',
        closedAt: '2026-09-02T10:00:00.000Z',
        title: 'Closed directly',
      });
      const resolvedId = await seedIncident(tenantId, {
        severity: 'sev1',
        status: 'closed',
        createdAt: '2026-09-02T09:30:00.000Z',
        resolvedAt: '2026-09-02T11:00:00.000Z',
        closedAt: '2026-09-02T12:00:00.000Z',
        title: 'Recovered before closure',
      });

      expect(await readIncidentFreeStatus(tenantId)).toMatchObject({
        state: 'running',
        startedAt: new Date('2026-09-02T11:00:00.000Z'),
        qualifyingActiveCount: 0,
        scope: { severities: ['sev1', 'sev2'] },
        lastIncident: { id: resolvedId, title: 'Recovered before closure', severity: 'sev1' },
      });

      await fixture.admin.db.delete(incidents).where(eq(incidents.id, resolvedId));
      expect(await readIncidentFreeStatus(tenantId)).toMatchObject({
        state: 'running',
        startedAt: new Date('2026-09-02T10:00:00.000Z'),
        lastIncident: { id: fallbackId },
      });
    });
  });

  test('C2/C10 pauses for every active SEV1/SEV2 incident while ignoring active SEV3', async () => {
    await withTenantRows('incident-free-paused', async (tenantId) => {
      await seedIncident(tenantId, {
        severity: 'sev1',
        status: 'open',
        createdAt: '2026-09-02T09:00:00.000Z',
      });
      await seedIncident(tenantId, {
        severity: 'sev2',
        status: 'mitigated',
        createdAt: '2026-09-02T10:00:00.000Z',
      });
      await seedIncident(tenantId, {
        severity: 'sev3',
        status: 'open',
        createdAt: '2026-09-02T11:00:00.000Z',
      });

      expect(await readIncidentFreeStatus(tenantId)).toMatchObject({
        state: 'paused',
        qualifyingActiveCount: 2,
        scope: { severities: ['sev1', 'sev2'] },
      });
    });
  });

  test('C3 reports never_observed when the tenant has only non-qualifying history', async () => {
    await withTenantRows('incident-free-never', async (tenantId) => {
      await seedIncident(tenantId, {
        severity: 'sev3',
        status: 'closed',
        createdAt: '2026-09-02T09:00:00.000Z',
        closedAt: '2026-09-02T10:00:00.000Z',
      });

      expect(await readIncidentFreeStatus(tenantId)).toMatchObject({
        state: 'never_observed',
        startedAt: null,
        qualifyingActiveCount: 0,
        scope: { severities: ['sev1', 'sev2'] },
        lastIncident: null,
      });
    });
  });

  test('C9/C10 includes archived lifecycle history without exposing its summary or another tenant', async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    await fixture.admin.db.insert(tenants).values([
      { id: tenantA, name: 'incident-free-archive-a' },
      { id: tenantB, name: 'incident-free-archive-b' },
    ]);
    try {
      await seedIncident(tenantA, {
        severity: 'sev2',
        status: 'closed',
        createdAt: '2026-09-02T09:00:00.000Z',
        closedAt: '2026-09-02T10:00:00.000Z',
        archivedAt: '2026-09-02T10:05:00.000Z',
        title: 'Archived tenant A incident',
      });
      const tenantBId = await seedIncident(tenantB, {
        severity: 'sev1',
        status: 'resolved',
        createdAt: '2026-09-02T09:00:00.000Z',
        resolvedAt: '2026-09-02T11:00:00.000Z',
        title: 'Tenant B incident',
      });

      expect(await readIncidentFreeStatus(tenantA)).toMatchObject({
        state: 'running',
        startedAt: new Date('2026-09-02T10:00:00.000Z'),
        lastIncident: null,
      });
      expect(await readIncidentFreeStatus(tenantB)).toMatchObject({
        state: 'running',
        startedAt: new Date('2026-09-02T11:00:00.000Z'),
        lastIncident: { id: tenantBId, title: 'Tenant B incident' },
      });
    } finally {
      await fixture.admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await fixture.admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    }
  });
});
