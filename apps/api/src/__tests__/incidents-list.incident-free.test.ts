import { randomUUID } from 'node:crypto';
import * as db from '@sre/db';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import { createFixture } from './incidents.fixture';

const fixture = createFixture();

type IncidentListBody = {
  incidents: Array<{ id: string }>;
  incidentFreeStatus?: {
    state: 'running' | 'paused' | 'never_observed' | 'unavailable';
    asOf: string;
    startedAt: string | null;
    qualifyingActiveCount: number;
    scope: { severities: ['sev1', 'sev2'] };
    lastIncident: { id: string; title: string | null; severity: string } | null;
  };
};

describe('GET /incidents?state=open incident-free status', () => {
  test('C2/C10 returns a server-timestamped paused status and disclosed SEV1/SEV2 scope', async () => {
    const response = await fixture.api.request(
      '/incidents?state=open',
      fixture.auth(await fixture.sign(fixture.orgA)),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as IncidentListBody;

    expect(body.incidentFreeStatus).toMatchObject({
      state: 'paused',
      qualifyingActiveCount: 2,
      scope: { severities: ['sev1', 'sev2'] },
    });
    expect(Number.isNaN(Date.parse(body.incidentFreeStatus!.asOf))).toBe(false);
  });

  test('C3/C9 keeps SEV3 out of scope, then counts archived SEV2 history without exposing its summary', async () => {
    const auth = fixture.auth(await fixture.sign(fixture.orgB));
    const before = await fixture.api.request('/incidents?state=open', auth);
    expect((await before.json()) as IncidentListBody).toMatchObject({
      incidentFreeStatus: {
        state: 'never_observed',
        startedAt: null,
        qualifyingActiveCount: 0,
        scope: { severities: ['sev1', 'sev2'] },
        lastIncident: null,
      },
    });

    const id = randomUUID();
    await fixture.admin.db.insert(db.incidents).values({
      id,
      tenantId: fixture.tenantB,
      fingerprint: `incident-free-api-${id}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
      status: 'closed',
      title: 'Archived history must stay private',
      closedAt: new Date('2026-09-02T10:00:00.000Z'),
      archivedAt: new Date('2026-09-02T10:05:00.000Z'),
    });
    try {
      const after = await fixture.api.request('/incidents?state=open', auth);
      expect(after.status).toBe(200);
      expect((await after.json()) as IncidentListBody).toMatchObject({
        incidentFreeStatus: {
          state: 'running',
          startedAt: '2026-09-02T10:00:00.000Z',
          qualifyingActiveCount: 0,
          scope: { severities: ['sev1', 'sev2'] },
          lastIncident: null,
        },
      });
    } finally {
      await fixture.admin.db.delete(db.incidents).where(eq(db.incidents.id, id));
    }
  });

  test('C4 isolates projection failure so the incident queue remains usable and reports unavailable', async () => {
    const repo = db as unknown as {
      readIncidentFreeStatus: (...args: unknown[]) => Promise<unknown>;
    };
    const statusSpy = vi
      .spyOn(repo, 'readIncidentFreeStatus')
      .mockRejectedValueOnce(new Error('incident-free projection unavailable'));
    try {
      const response = await fixture.api.request(
        '/incidents?state=open',
        fixture.auth(await fixture.sign(fixture.orgA)),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as IncidentListBody;
      expect(body.incidents.length).toBeGreaterThan(0);
      expect(body.incidentFreeStatus).toMatchObject({
        state: 'unavailable',
        startedAt: null,
        scope: { severities: ['sev1', 'sev2'] },
        lastIncident: null,
      });
    } finally {
      statusSpy.mockRestore();
    }
  });

  test('scrubs secrets from the last qualifying incident summary', async () => {
    const gitlabToken = 'glpat-ABCDEF1234567890abcd';
    const highEntropyToken = 'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2';
    const id = randomUUID();
    await fixture.admin.db.insert(db.incidents).values({
      id,
      tenantId: fixture.tenantB,
      fingerprint: `incident-free-secret-${id}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev1',
      status: 'resolved',
      title: `Recovered ${gitlabToken} ${highEntropyToken}`,
      resolvedAt: new Date('2026-09-02T12:00:00.000Z'),
    });
    try {
      const response = await fixture.api.request(
        '/incidents?state=open',
        fixture.auth(await fixture.sign(fixture.orgB)),
      );
      const body = (await response.json()) as IncidentListBody;
      expect(body.incidentFreeStatus?.lastIncident).toMatchObject({
        id,
        title: 'Recovered [REDACTED] [REDACTED]',
        severity: 'sev1',
      });
      expect(JSON.stringify(body)).not.toContain(gitlabToken);
      expect(JSON.stringify(body)).not.toContain(highEntropyToken);
    } finally {
      await fixture.admin.db.delete(db.incidents).where(eq(db.incidents.id, id));
    }
  });
});
