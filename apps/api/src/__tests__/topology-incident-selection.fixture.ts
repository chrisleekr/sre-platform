import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectorConfigs,
  incidents,
  incidentSignals,
  persistTopologyDiscovery,
  type Db,
} from '@sre/db';
import { topologyRefKey, type TopologyEntity } from '@sre/contracts';
import type { makeApp } from '../app';

/** Verify selected-incident reads preserve exact scope and enforce the existing tenant boundary. */
export async function verifyTopologyIncidentSelection(
  api: ReturnType<typeof makeApp>,
  admin: Db,
  app: Db,
  tenantId: string,
  ownToken: string,
  otherToken: string,
) {
  const sourceId = randomUUID(),
    incidentId = randomUUID();
  const subject = (environment: string): TopologyEntity => ({
    ref: {
      authority: `connector:${sourceId}`,
      kind: 'service',
      id: JSON.stringify([environment, 'selection-service']),
    },
    kind: 'service',
    name: 'selection-service',
    scope: { environment },
    attributes: {},
  });
  const prod = subject('production');
  const key = topologyRefKey(prod.ref);
  const request = (token?: string, id: string = incidentId) =>
    api.request(`/topology/incidents/${id}/context`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  try {
    await admin
      .insert(connectorConfigs)
      .values({ id: sourceId, tenantId, name: 'Selection APM', type: 'datadog' });
    await persistTopologyDiscovery(
      app,
      tenantId,
      { id: sourceId, lifecycleVersion: 0 },
      {
        observedAt: new Date().toISOString(),
        collections: [
          {
            key: 'apm',
            completeness: 'partial',
            issue: 'sampling',
            entities: [prod, subject('staging')],
            relations: [],
          },
        ],
      },
    );
    await admin.insert(incidents).values({
      id: incidentId,
      tenantId,
      fingerprint: incidentId,
      alertSource: 'platform',
      service: 'unclassified',
      severity: 'sev3',
    });
    await admin.insert(incidentSignals).values({
      tenantId,
      incidentId,
      surface: 'platform',
      channel: 'test',
      externalMessageId: incidentId,
      state: 'firing',
      lastEventType: 'opened',
      summary: 'Runtime needs attention',
      contentHash: incidentId,
      lastEventKey: incidentId,
      lastEventAt: new Date(),
      affectedEntities: [
        {
          key: 'selected-runtime',
          topologySubjectKey: key,
          kind: 'service',
          stableId: prod.name,
          displayName: prod.name,
          scope: prod.scope,
          provenance: { kind: 'platform_snapshot', source: 'topology' },
          confidence: 100,
          completeness: 'partial',
          observedAt: new Date().toISOString(),
          requiredCapabilities: ['topology'],
        },
      ],
    });
    const response = await request(ownToken);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      incidentId,
      assignedServices: [],
      topology: {
        resolutions: [{ status: 'resolved', subjectKey: key }],
        subjects: [{ name: prod.name, scope: prod.scope }],
      },
    });
    expect(JSON.stringify(body)).not.toContain('staging');
    const impact = await api.request(
      `/topology/blast-radius?service=${prod.name}&subjectKey=${encodeURIComponent(key)}`,
      { headers: { authorization: `Bearer ${ownToken}` } },
    );
    expect(await impact.json()).toMatchObject({ mapped: true, subjectKey: key, scope: prod.scope });
    expect((await request(otherToken)).status).toBe(404);
    expect((await request()).status).toBe(401);
    expect((await request(ownToken, 'invalid')).status).toBe(400);
    expect((await request(ownToken, randomUUID())).status).toBe(404);
  } finally {
    await admin.delete(incidentSignals).where(eq(incidentSignals.incidentId, incidentId));
    await admin.delete(incidents).where(eq(incidents.id, incidentId));
    await admin.delete(connectorConfigs).where(eq(connectorConfigs.id, sourceId));
  }
}
