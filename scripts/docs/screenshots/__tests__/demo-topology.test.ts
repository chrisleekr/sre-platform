import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  connectorConfigs,
  makeDb,
  tenants,
  type DbHandle,
} from '../../../../packages/db/src/index';
import { readDiscoveredTopology } from '../../../../packages/topology/src/discovery-repo';
import { seedDiscoveredTopology } from '../demo-topology';

const tenantId = randomUUID();
const connectors = {
  kubernetes: randomUUID(),
  datadog: randomUUID(),
  gitlab: randomUUID(),
  argocd: randomUUID(),
  prometheus: randomUUID(),
};
let admin: DbHandle, app: DbHandle;
beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'Documentation topology' });
  await admin.db.insert(connectorConfigs).values(
    Object.entries(connectors).map(([type, id]) => ({
      tenantId,
      id,
      type,
      name: `Demo ${type}`,
      enabled: true,
    })),
  );
});
afterAll(async () => {
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), app.close()]);
});

test('the documentation seed resolves traffic, service bindings and cross-connector context', async () => {
  await seedDiscoveredTopology({ appDb: app.db, tenantId, now: new Date() }, connectors);
  const graph = await readDiscoveredTopology(app.db, tenantId);
  const byKey = new Map(graph.entities.map((entity) => [entity.key, entity]));
  const calls = graph.relations.filter((edge) => edge.kind === 'calls');
  expect(calls.filter((edge) => edge.fromKey && edge.toKey)).toHaveLength(4);
  expect(calls.filter((edge) => !edge.toKey)).toHaveLength(1);
  expect(
    calls.find((edge) => byKey.get(edge.toKey!)?.ref.kind === 'Service')?.attributes?.outcome,
  ).toBe('attempt_recorded');
  expect(calls.some((edge) => edge.attributes?.outcome === 'response_recorded')).toBe(true);
  expect(
    graph.coverage.find(
      (source) => source.connectorType === 'datadog' && source.collection === 'logs',
    ),
  ).toMatchObject({
    completeness: 'partial',
    issue: 'sampling',
  });
  expect(
    graph.relations.some((edge) => edge.kind === 'manages' && edge.fromKey && edge.toKey),
  ).toBe(true);
  expect(
    graph.entities
      .filter((entity) => entity.kind === 'repository')
      .every(
        (entity) =>
          entity.sources.some((source) => source.connectorType === 'gitlab') &&
          entity.sources.some((source) => source.connectorType === 'kubernetes'),
      ),
  ).toBe(true);
  const services = graph.operational.subjects.filter((subject) => subject.kind === 'service');
  expect(
    services
      .filter((subject) => subject.name === 'checkout-api')
      .map((subject) => subject.scope.environment)
      .sort(),
  ).toEqual(['production', 'staging']);
  const serviceKeys = new Set(services.map((subject) => subject.key));
  const dependencies = graph.operational.relations.filter(
    (edge) => edge.kind === 'calls' && serviceKeys.has(edge.from) && serviceKeys.has(edge.to),
  );
  expect(dependencies).toHaveLength(3);
  expect(
    dependencies.every(
      (edge) => !edge.stale && edge.attributes?.projection === 'Explicit runtime service bindings',
    ),
  ).toBe(true);
});
