/**
 * The demo tenant's standing environment: its service graph, its connected data sources, and the
 * cluster and GitOps state those data sources last reported.
 */
import type { NormalizedSnapshot } from '../../../packages/connectors/src/index';
import {
  connectorCredentialKey,
  connectorConfigs,
  serviceDependencies,
  services,
  withTenant,
  type Db,
  type SecretStore,
} from '../../../packages/db/src/index';
import type { Queue, SnapshotCache } from '../../../packages/queue/src/index';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface DemoSeedDeps {
  /** RLS-scoped connection. Every tenant-owned write runs inside `withTenant`. */
  appDb: Db;
  /** Administrative connection, for the few tables the application role cannot reach. */
  adminDb: Db;
  /** Real queue against the ephemeral Valkey: the opener enqueues a triage job nobody consumes. */
  queue: Queue;
  cache: SnapshotCache;
  /** Encrypted credential store, so the saved data sources read as connected rather than broken. */
  secrets: SecretStore;
  tenantId: string;
  /** Signed-in recipient used for inbox examples. */
  userId: string;
  /** Anchor for every relative timestamp. */
  now: Date;
}

const SERVICES = [
  { name: 'checkout-api', team: 'Payments', criticality: 'tier-1' },
  { name: 'payments-gateway', team: 'Payments', criticality: 'tier-1' },
  { name: 'orders-service', team: 'Fulfilment', criticality: 'tier-2' },
  { name: 'inventory-service', team: 'Fulfilment', criticality: 'tier-2' },
  { name: 'search-api', team: 'Discovery', criticality: 'tier-3' },
  { name: 'notification-worker', team: 'Platform', criticality: 'tier-3' },
  { name: 'session-store', team: 'Platform', criticality: 'tier-1' },
];

const DEPENDENCIES = [
  { upstream: 'checkout-api', downstream: 'payments-gateway', protocol: 'http', sync: 'sync' },
  { upstream: 'checkout-api', downstream: 'orders-service', protocol: 'http', sync: 'sync' },
  { upstream: 'checkout-api', downstream: 'session-store', protocol: 'redis', sync: 'sync' },
  { upstream: 'orders-service', downstream: 'inventory-service', protocol: 'grpc', sync: 'sync' },
  {
    upstream: 'orders-service',
    downstream: 'notification-worker',
    protocol: 'amqp',
    sync: 'async',
  },
  { upstream: 'search-api', downstream: 'inventory-service', protocol: 'http', sync: 'sync' },
];

/** Writes the service graph the topology panel and the blast-radius query read. */
export async function seedTopology(deps: DemoSeedDeps): Promise<void> {
  await withTenant(deps.appDb, deps.tenantId, async (tx) => {
    await tx
      .insert(services)
      .values(SERVICES.map((service) => ({ tenantId: deps.tenantId, ...service })));
    await tx.insert(serviceDependencies).values(
      DEPENDENCIES.map((edge) => ({
        tenantId: deps.tenantId,
        upstream: edge.upstream,
        downstream: edge.downstream,
        protocol: edge.protocol,
        syncType: edge.sync,
        circuitBreaker: edge.sync === 'sync' && edge.downstream !== 'session-store',
      })),
    );
  });
}

export interface SeededConnectors {
  kubernetes: string;
  prometheus: string;
  gitlab: string;
  argocd: string;
  datadog: string;
}

/**
 * Connected demo data sources. Settings carry no credentials: the real
 * secrets live in the encrypted store, and a screenshot must never depend on one.
 */
export async function seedConnectors(deps: DemoSeedDeps): Promise<SeededConnectors> {
  const { now } = deps;
  const rows = [
    {
      type: 'datadog',
      name: 'Datadog request logs',
      settings: { site: 'datadoghq.eu', collectLogs: true, collectApm: false },
    },
    {
      type: 'kubernetes',
      name: 'Production cluster',
      settings: { namespaces: ['checkout', 'orders', 'platform'], apiUrl: 'https://k8s.internal' },
    },
    {
      type: 'prometheus',
      name: 'Prometheus (production)',
      settings: { baseUrl: 'https://prometheus.internal', alertmanager: true },
    },
    {
      type: 'gitlab',
      name: 'GitLab: acme group',
      settings: { groupPath: 'acme', baseUrl: 'https://gitlab.internal' },
    },
    {
      type: 'argocd',
      name: 'Argo CD (production)',
      settings: {
        baseUrl: 'https://argocd.internal',
        projects: [
          {
            project: 'production',
            applications: [{ name: 'checkout-api' }, { name: 'orders-service' }],
          },
        ],
      },
    },
  ];

  return withTenant(deps.appDb, deps.tenantId, async (tx) => {
    const inserted = await tx
      .insert(connectorConfigs)
      .values(
        rows.map((row) => ({
          tenantId: deps.tenantId,
          type: row.type,
          name: row.name,
          settings: row.settings,
          enabled: true,
          verificationAttemptedAt: new Date(now.getTime() - 3 * DAY),
          verificationSucceededAt: new Date(now.getTime() - 3 * DAY),
          verificationDurationMs: 412,
          pollAttemptedAt: new Date(now.getTime() - 40_000),
          pollSucceededAt: new Date(now.getTime() - 40_000),
          pollSnapshotCount: 24,
          pollDurationMs: 730,
        })),
      )
      .returning({ id: connectorConfigs.id, type: connectorConfigs.type });

    // Without a stored credential every saved source renders as "Credential missing". The values
    // are invented and the store encrypts them exactly as it would a real one. Argo CD is the one
    // shape that is checked rather than merely present: the card parses the blob as a per-project
    // token bundle, so a plain string reads as missing.
    for (const row of inserted) {
      let credential = JSON.stringify({ token: 'demo-not-a-real-credential' });
      if (row.type === 'datadog')
        credential = JSON.stringify({ apiKey: 'demo-api-key', appKey: 'demo-application-key' });
      else if (row.type === 'argocd')
        credential = JSON.stringify({
          version: 1,
          tokens: [{ project: 'production', token: 'demo-not-a-real-credential' }],
        });
      await deps.secrets.put(deps.tenantId, connectorCredentialKey(row.id), credential, tx);
    }

    const byType = (type: string): string => {
      const row = inserted.find((candidate) => candidate.type === type);
      if (!row) throw new Error(`demo seed: connector ${type} was not inserted`);
      return row.id;
    };
    return {
      kubernetes: byType('kubernetes'),
      prometheus: byType('prometheus'),
      gitlab: byType('gitlab'),
      argocd: byType('argocd'),
      datadog: byType('datadog'),
    };
  });
}

function pod(
  tenantId: string,
  observedAt: Date,
  name: string,
  namespace: string,
  restarts: number,
  ready: boolean,
  waitingReason?: string,
): NormalizedSnapshot {
  return {
    tenantId,
    source: 'kubernetes',
    entityId: name,
    metrics: { restarts, containersReady: ready ? 1 : 0, containers: 1 },
    metadata: {
      kind: 'pod',
      namespace,
      phase: ready ? 'Running' : 'Pending',
      containers: [
        {
          name: name.split('-').slice(0, 2).join('-'),
          ready,
          restartCount: restarts,
          ...(waitingReason ? { waitingReason } : {}),
          ...(restarts > 0
            ? {
                lastTerminatedReason: 'OOMKilled',
                lastTerminatedAt: new Date(observedAt.getTime() - 9 * MINUTE).toISOString(),
              }
            : {}),
        },
      ],
    },
    observedAt,
  };
}

/** Cluster and GitOps state, written where the panels actually read it: the Valkey snapshot cache. */
export async function seedSnapshots(
  deps: DemoSeedDeps,
  connectors: SeededConnectors,
): Promise<void> {
  const observedAt = new Date(deps.now.getTime() - 40_000);
  const infra: NormalizedSnapshot[] = [
    pod(
      deps.tenantId,
      observedAt,
      'checkout-api-7d9f4b8c6-4xk2p',
      'checkout',
      3,
      false,
      'CrashLoopBackOff',
    ),
    pod(deps.tenantId, observedAt, 'checkout-api-7d9f4b8c6-9wqmt', 'checkout', 0, true),
    pod(deps.tenantId, observedAt, 'orders-service-5c4b7a9d2-lm8vz', 'orders', 0, true),
    pod(deps.tenantId, observedAt, 'inventory-service-6f8d2c1b4-t7nrs', 'orders', 1, true),
    pod(deps.tenantId, observedAt, 'notification-worker-84bd6e5f9-2hqxc', 'platform', 0, true),
    {
      tenantId: deps.tenantId,
      source: 'kubernetes',
      entityId: 'ip-10-0-14-201.eu-west-1.compute.internal',
      metrics: { pods: 34, allocatableCpuMilli: 7900, allocatableMemoryMi: 30_720 },
      metadata: { kind: 'node', phase: 'Ready', pressures: ['MemoryPressure'] },
      observedAt,
    },
    {
      tenantId: deps.tenantId,
      source: 'kubernetes',
      entityId: 'ip-10-0-22-118.eu-west-1.compute.internal',
      metrics: { pods: 28, allocatableCpuMilli: 7900, allocatableMemoryMi: 30_720 },
      metadata: { kind: 'node', phase: 'Ready' },
      observedAt,
    },
  ];

  const gitops: NormalizedSnapshot[] = [
    {
      tenantId: deps.tenantId,
      source: 'argocd',
      entityId: 'production/checkout-api',
      metrics: { outOfSyncResources: 2 },
      metadata: {
        kind: 'application',
        applicationId: 'production/checkout-api',
        applicationName: 'checkout-api',
        applicationNamespace: 'argocd',
        project: 'production',
        syncStatus: 'OutOfSync',
        healthStatus: 'Degraded',
        healthMessage: 'Deployment has 1 unavailable replica',
        operationPhase: 'Failed',
        operationMessage: 'one or more objects failed to apply',
        revisions: ['9c14aa2f0b7d4e1a8f3c6b52d7e0a419cc83b6d2'],
        destinationServer: 'https://kubernetes.default.svc',
        destinationNamespace: 'checkout',
        conditions: [
          {
            type: 'SyncError',
            message: 'Deployment.apps "checkout-api" is invalid: memory limit below request',
            lastTransitionTime: new Date(deps.now.getTime() - 22 * MINUTE).toISOString(),
          },
        ],
      },
      observedAt,
    },
    {
      tenantId: deps.tenantId,
      source: 'argocd',
      entityId: 'production/orders-service',
      metrics: { outOfSyncResources: 0 },
      metadata: {
        kind: 'application',
        applicationId: 'production/orders-service',
        applicationName: 'orders-service',
        applicationNamespace: 'argocd',
        project: 'production',
        syncStatus: 'Synced',
        healthStatus: 'Healthy',
        revisions: ['4b7e91d3c05a2f68e1d94c7b3a02f8516de7c904'],
        destinationServer: 'https://kubernetes.default.svc',
        destinationNamespace: 'orders',
        conditions: [],
      },
      observedAt,
    },
  ];

  // lifecycleVersion 0 matches the freshly inserted connector rows the read path keys on.
  await deps.cache.set(deps.tenantId, 'kubernetes', infra, 3600, {
    id: connectors.kubernetes,
    lifecycleVersion: 0,
  });
  await deps.cache.set(deps.tenantId, 'argocd', gitops, 3600, {
    id: connectors.argocd,
    lifecycleVersion: 0,
  });
}
