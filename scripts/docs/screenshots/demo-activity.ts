/**
 * Deploy and source-control history for the demo tenant.
 *
 * Both panels read durable Postgres tables rather than a live connector call, so this is the whole
 * of what they display.
 */
import { deployments, gitlabEvents, withTenant } from '../../../packages/db/src/index';
import type { DemoSeedDeps, SeededConnectors } from './demo-environment';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Deploy history for the deployments panel and the deploy-correlation evidence on an incident. */
export async function seedDeployments(
  deps: DemoSeedDeps,
  connectors: SeededConnectors,
): Promise<void> {
  const { now } = deps;
  const rows = [
    {
      source: 'argocd',
      connectorId: connectors.argocd,
      repo: 'acme/checkout-api',
      service: 'checkout-api',
      environment: 'production',
      ref: 'main',
      sha: '9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2',
      actor: 'release-bot',
      status: 'failure',
      operationPhase: 'Failed',
      deployedAt: new Date(now.getTime() - 26 * MINUTE),
    },
    {
      source: 'gitlab',
      connectorId: connectors.gitlab,
      repo: 'acme/orders-service',
      service: 'orders-service',
      environment: 'production',
      ref: 'main',
      sha: '4b7e91d3c05a2f68e1d94c7b3a02f8516de7c904',
      actor: 'release-bot',
      status: 'success',
      deployedAt: new Date(now.getTime() - 3 * HOUR),
    },
    {
      source: 'gitlab',
      connectorId: connectors.gitlab,
      repo: 'acme/search-api',
      service: 'search-api',
      environment: 'staging',
      ref: 'main',
      sha: 'a3f5c8e21d90b47e6c1a5f83b2d70e94ac16f5b8',
      actor: 'release-bot',
      status: 'success',
      transientEnvironment: false,
      deployedAt: new Date(now.getTime() - 7 * HOUR),
    },
    {
      source: 'gitlab',
      connectorId: connectors.gitlab,
      repo: 'acme/checkout-api',
      service: 'checkout-api',
      environment: 'production',
      ref: 'main',
      sha: '61d0b9c4a72f8e35d19c0b74e2a86f5301cd7e4b',
      actor: 'release-bot',
      status: 'success',
      deployedAt: new Date(now.getTime() - 1 * DAY),
    },
    {
      source: 'gitlab',
      connectorId: connectors.gitlab,
      repo: 'acme/inventory-service',
      service: 'inventory-service',
      environment: 'production',
      ref: 'main',
      sha: 'd82e470bc9a15f36e0b8d24c7a95f1e30ba6c847',
      actor: 'release-bot',
      status: 'success',
      deployedAt: new Date(now.getTime() - 2 * DAY),
    },
  ];
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx.insert(deployments).values(rows.map((row) => ({ tenantId: deps.tenantId, ...row }))),
  );
}

/** Source-control activity for the changes panel. */
export async function seedChanges(deps: DemoSeedDeps, connectors: SeededConnectors): Promise<void> {
  const { now } = deps;
  const rows = [
    {
      deliveryId: 'demo-pipeline-4812',
      eventType: 'pipeline',
      action: 'failed',
      projectFullPath: 'acme/checkout-api',
      ref: 'main',
      sha: '9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2',
      actor: 'release-bot',
      summary: { status: 'failed', name: 'deploy:production', duration: 214 },
      occurredAt: new Date(now.getTime() - 24 * MINUTE),
    },
    {
      deliveryId: 'demo-push-9931',
      eventType: 'push',
      action: null,
      projectFullPath: 'acme/checkout-api',
      ref: 'main',
      sha: '9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2',
      actor: 'a.okafor',
      summary: { message: 'Raise checkout worker concurrency to 32', commits: 1 },
      occurredAt: new Date(now.getTime() - 38 * MINUTE),
    },
    {
      deliveryId: 'demo-mr-2210',
      eventType: 'merge_request',
      action: 'merge',
      projectFullPath: 'acme/checkout-api',
      ref: 'feature/worker-concurrency',
      sha: '9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2',
      actor: 'a.okafor',
      summary: { title: 'Raise checkout worker concurrency', state: 'merged', iid: 2210 },
      occurredAt: new Date(now.getTime() - 45 * MINUTE),
    },
    {
      deliveryId: 'demo-pipeline-4809',
      eventType: 'pipeline',
      action: 'success',
      projectFullPath: 'acme/orders-service',
      ref: 'main',
      sha: '4b7e91d3c05a2f68e1d94c7b3a02f8516de7c904',
      actor: 'release-bot',
      summary: { status: 'success', name: 'deploy:production', duration: 189 },
      occurredAt: new Date(now.getTime() - 3 * HOUR),
    },
    {
      deliveryId: 'demo-release-118',
      eventType: 'release',
      action: 'create',
      projectFullPath: 'acme/orders-service',
      ref: 'v2.14.0',
      sha: '4b7e91d3c05a2f68e1d94c7b3a02f8516de7c904',
      actor: 'release-bot',
      summary: { name: 'v2.14.0', state: 'created' },
      occurredAt: new Date(now.getTime() - 3 * HOUR),
    },
    {
      deliveryId: 'demo-mr-2207',
      eventType: 'merge_request',
      action: 'open',
      projectFullPath: 'acme/inventory-service',
      ref: 'feature/stock-reservation',
      sha: 'd82e470bc9a15f36e0b8d24c7a95f1e30ba6c847',
      actor: 'm.lindqvist',
      summary: { title: 'Reserve stock before payment capture', state: 'opened', iid: 2207 },
      occurredAt: new Date(now.getTime() - 5 * HOUR),
    },
  ];
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx.insert(gitlabEvents).values(
      rows.map((row) => ({
        tenantId: deps.tenantId,
        connectorId: connectors.gitlab,
        projectId: '4471',
        ...row,
      })),
    ),
  );
}
