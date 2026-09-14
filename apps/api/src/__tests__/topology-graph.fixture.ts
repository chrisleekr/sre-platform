import { expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { connectorConfigs, persistTopologyDiscovery, type Db } from '@sre/db';
import type { makeApp } from '../app';

export interface GraphNode {
  name: string;
  team: string | null;
  criticality: string | null;
  lastDeployAt: string | null;
  recentDeploys: { sha: string; deployedAt: string }[];
  sources: string[];
}
export interface GraphBody {
  nodes: GraphNode[];
  edges: { upstream: string; downstream: string; syncType: string; circuitBreaker: boolean }[];
  infrastructure: Array<{
    entityId: string;
    kind?: string;
    namespace?: string;
    error?: string;
    [key: string]: unknown;
  }>;
}

/** Exercise discovery through the authenticated graph endpoint using the shared two-tenant harness. */
export async function verifyDiscoveredTopologyAccess(
  api: ReturnType<typeof makeApp>,
  admin: Db,
  app: Db,
  tenantId: string,
  ownToken: string,
  otherToken: string,
) {
  const id = randomUUID();
  await admin
    .insert(connectorConfigs)
    .values({ id, tenantId, type: 'prometheus', name: 'Telemetry' });
  await persistTopologyDiscovery(
    app,
    tenantId,
    { id, lifecycleVersion: 0 },
    {
      observedAt: new Date().toISOString(),
      collections: [
        {
          key: 'targets',
          completeness: 'complete',
          relations: [],
          entities: [
            {
              ref: { authority: `connector:${id}`, kind: 'endpoint', id: 'target-one' },
              kind: 'endpoint',
              name: 'External API',
              scope: {},
              attributes: {},
            },
          ],
        },
      ],
    },
  );
  const own = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${ownToken}` },
  });
  expect(own.status).toBe(200);
  expect(await own.json()).toMatchObject({
    nodes: [],
    discovery: {
      entities: [
        expect.objectContaining({
          name: 'External API',
          sources: [expect.objectContaining({ connectorId: id })],
        }),
      ],
    },
  });
  const foreign = await api.request('/topology/graph', {
    headers: { authorization: `Bearer ${otherToken}` },
  });
  expect(JSON.stringify(await foreign.json())).not.toContain('External API');
}
