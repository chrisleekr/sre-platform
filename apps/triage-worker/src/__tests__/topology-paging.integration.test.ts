import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeGitLabConnector, type IDataSourceConnector } from '@sre/connectors';
import {
  makeDb,
  tenants,
  connectorConfigs,
  syncGitLabProjects,
  listGitLabProjects,
  readTopologyScans,
  persistTopologyDiscovery,
  recordTopologyDiscoveryFailure,
  listTopologyDiscovery,
} from '@sre/db';
import type { Job } from '@sre/queue';
import { makeTopologyDiscoveryHandler } from '../topology-discovery';

test('worker restarts resume the durable admitted repository scan and retain all earlier pages', async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  const admin = makeDb(process.env.DATABASE_URL!);
  const app = makeDb(process.env.APP_DATABASE_URL!);
  const tenantId = randomUUID(),
    connectorId = randomUUID();
  try {
    await admin.db.insert(tenants).values({ id: tenantId, name: 'Paged topology' });
    await admin.db
      .insert(connectorConfigs)
      .values({ id: connectorId, tenantId, type: 'gitlab', name: 'Source' });
    await syncGitLabProjects(
      app.db,
      tenantId,
      connectorId,
      'group',
      Array.from({ length: 205 }, (_, i) => ({
        projectId: String(i).padStart(4, '0'),
        groupId: 'group',
        name: `repo-${i}`,
        fullPath: `team/repo-${i}`,
        webUrl: `https://git.example/team/repo-${i}`,
        visibility: 'private',
        archived: false,
      })),
    );
    const getCredential = vi.fn(async () => {
      throw new Error('Catalog discovery must not fetch credentials');
    });
    const source: IDataSourceConnector = {
      ...makeGitLabConnector({
        id: connectorId,
        tenantId,
        name: 'Source',
        type: 'gitlab',
        settings: { baseUrl: 'https://git.example' },
        getCredential,
        repositories: {
          page: (after, limit) =>
            listGitLabProjects(app.db, tenantId, connectorId, {
              afterRepositoryId: after ?? '',
              limit,
            }),
          search: async () => {
            throw new Error('Must use catalog paging');
          },
          resolve: async () => [],
          recentEvents: async () => [],
        },
      }),
      generation: { id: connectorId, lifecycleVersion: 0 },
    };
    const jobs: Job[] = [
      {
        id: randomUUID(),
        tenantId,
        type: 'topology.discover',
        payload: { connectorId },
        attempts: 0,
      },
    ];
    let handled = 0;
    while (jobs.length) {
      expect(handled).toBeLessThan(4);
      // Reconstruct the worker between pages so no adapter-local cursor can satisfy the test.
      const handler = makeTopologyDiscoveryHandler({
        connectorProvider: () => async () => [source],
        scans: (tenant, generation) => readTopologyScans(app.db, tenant, generation),
        persist: (tenant, generation, result) =>
          persistTopologyDiscovery(app.db, tenant, generation, result),
        failed: (tenant, generation, at, issue) =>
          recordTopologyDiscoveryFailure(app.db, tenant, generation, at, issue),
        continueScan: async (tenant, id, pageCount, collections) => {
          jobs.push({
            id: randomUUID(),
            tenantId: tenant,
            type: 'topology.discover',
            payload: { connectorId: id, pageCount, collections },
            attempts: 0,
          });
        },
      });
      await handler(jobs.shift()!);
      handled++;
    }
    expect(handled).toBe(3);
    expect(getCredential).not.toHaveBeenCalled();
    const result = (await listTopologyDiscovery(app.db, tenantId)).find(
      (row) => row.collection.key === 'repositories',
    )!;
    expect(result.collection.completeness).toBe('complete');
    expect(new Set(result.collection.entities.map((e) => e.value.ref.id)).size).toBe(205);
    expect(await readTopologyScans(app.db, tenantId, source.generation!)).toEqual({});
  } finally {
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await app.close();
    await admin.close();
  }
});
