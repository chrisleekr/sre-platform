import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dnsLookup, type HostLookup } from '../../ssrf';
import { kubernetesEntityCoverage } from '../../entity-coverage';
import type {
  IDataSourceConnector,
  NormalizedSnapshot,
  ProbeResult,
  TriageContext,
} from '../../types';
import { obj, str } from '../../values';
import { validateSegment } from './path';
import {
  K8sApiError,
  itemsOf,
  k8sClient,
  mapEvent,
  mapNode,
  mapPod,
  nodeSnapshot,
  podSnapshot,
  runtimeArtifacts,
  withinWindow,
} from './runtime';
import { makeK8sTools } from './tools';

/** Injectable so the REST calls are unit-testable without the network. */
type FetchLike = typeof fetch;
const MAX_RUNTIME_POD_PAGES = 5;

const KUBERNETES_CONNECTOR = {
  type: 'kubernetes',
  capabilities: {
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'snapshots',
    events: 'none',
  },
} as const;

/**
 * Creates a Kubernetes adapter with bounded runtime, event, metric, and log reads.
 *
 * @remarks Private API servers are admitted through CA pinning and redirect refusal, not host allowlists.
 * @param config - Tenant-scoped Kubernetes API settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Kubernetes API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 */
export function makeKubernetesConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): IDataSourceConnector {
  const namespace = str(config.settings.namespace) ?? null;
  const clusterName = str(config.settings.name) ?? null;
  return createDataSourceConnector(config, KUBERNETES_CONNECTOR, {
    entityCoverage: kubernetesEntityCoverage(namespace, clusterName, config.id),
    runtimeArtifacts: {
      async observe(service) {
        const { kjson } = await k8sClient(config, fetchImpl, lookup);
        const initialPath = namespace
          ? `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=200`
          : '/api/v1/pods?limit=200';
        const pods: unknown[] = [];
        let path: string | null = initialPath;
        for (let page = 0; path && page < MAX_RUNTIME_POD_PAGES; page += 1) {
          const response = await kjson(path);
          pods.push(...itemsOf(response));
          const continuation = str(obj(obj(response).metadata).continue);
          path = continuation
            ? `${initialPath}&continue=${encodeURIComponent(continuation)}`
            : null;
        }
        return {
          artifacts: runtimeArtifacts(config, service, pods),
          incomplete: path !== null,
        };
      },
    },
    async snapshot(): Promise<NormalizedSnapshot[]> {
      const { kjson } = await k8sClient(config, fetchImpl, lookup);
      const observedAt = new Date();
      const out: NormalizedSnapshot[] = [];
      const ns = str(config.settings.namespace);

      // A blank namespace means the cluster-wide collection, matching the setup wizard and the
      // ClusterRoleBinding it installs. Both reads stay bounded to one page.
      const podPath = ns
        ? `/api/v1/namespaces/${encodeURIComponent(ns)}/pods?limit=200`
        : '/api/v1/pods?limit=200';
      const podsRaw = await kjson(podPath);
      for (const raw of itemsOf(podsRaw))
        out.push(podSnapshot(config.tenantId, ns, raw, observedAt));

      // Node health is additive, so a failed cluster-scoped read must not discard healthy pods. It
      // still emits a sanitized marker so the dashboard does not silently imply complete coverage.
      try {
        const nodesRaw = await kjson('/api/v1/nodes');
        for (const raw of itemsOf(nodesRaw))
          out.push(nodeSnapshot(config.tenantId, raw, observedAt));
      } catch (error) {
        out.push({
          tenantId: config.tenantId,
          source: 'kubernetes',
          entityId: 'cluster/nodes',
          metrics: {},
          metadata: {
            kind: 'node',
            error:
              error instanceof K8sApiError && error.status === 403
                ? 'node read denied'
                : 'node poll failed',
          },
          observedAt,
        });
      }

      return out;
    },
    async fetchTriageContext(query): Promise<TriageContext> {
      const { kjson } = await k8sClient(config, fetchImpl, lookup);
      const ns = str(config.settings.namespace) ?? query.service;

      const [podsRaw, eventsRaw, nodesRaw] = await Promise.all([
        // Pods and Warning events are namespace-scoped and strict: a failure fails the tool call.
        // limit=200: take a bounded first page (ignore the continue token). Triage needs a
        // representative sample, not the whole namespace — an unbounded list is a noisy-neighbor
        // memory/CPU cost on the shared worker for a very large or high-churn namespace (CWE-400).
        kjson(`/api/v1/namespaces/${encodeURIComponent(ns)}/pods?limit=200`),
        kjson(
          `/api/v1/namespaces/${encodeURIComponent(ns)}/events?fieldSelector=type%3DWarning&limit=200`,
        ),
        // Nodes are cluster-scoped; a namespace-scoped ServiceAccount 403s here. Best-effort: a
        // failure yields [] rather than sinking the whole read.
        kjson('/api/v1/nodes').catch(() => ({ items: [] as unknown[] })),
      ]);

      const pods = itemsOf(podsRaw).map(mapPod);
      const nodes = itemsOf(nodesRaw).map(mapNode);
      const warnings = itemsOf(eventsRaw)
        .map(mapEvent)
        .filter((w) => withinWindow(w.at, query.windowMinutes));

      return {
        source: 'kubernetes',
        data: { namespace: ns, windowMinutes: query.windowMinutes, pods, nodes, warnings },
      };
    },
    tools: () => makeK8sTools(config, fetchImpl, lookup),
    async probe(): Promise<ProbeResult> {
      const r = await probeKubernetes(config, fetchImpl, lookup);
      const status = r.reachable && r.canListPods ? 'healthy' : 'unhealthy';
      return {
        status,
        reachable: r.reachable,
        // The token is authorized for what triage reads (pods). Secret access is a warning, not auth.
        authorized: r.reachable && r.canListPods,
        warnings: r.warnings,
        checks: { canListPods: r.canListPods, secretsDenied: r.secretsDenied },
      };
    },
  });
}

export const kubernetesConnectorDefinition = defineConnector({
  ...KUBERNETES_CONNECTOR,
  create: makeKubernetesConnector,
});

/** The health signals a test-connection probe reports back for a Kubernetes connector. */
export interface KubernetesProbeResult {
  reachable: boolean;
  canListPods: boolean;
  secretsDenied: boolean;
  warnings: string[];
}

/**
 * Test-connection probe for a Kubernetes connector. Runs four unauthenticated-outcome-tolerant
 * reads and classifies the token's access without ever returning cluster data:
 * - `/api` establishes reachability (a 401/403 still means the server answered → reachable, warned);
 * - listing one pod establishes the token can read what triage needs (a 403 warns to apply RBAC);
 * - listing one secret verifies least privilege (a 403 is the healthy, expected outcome; a 200
 *   warns that the token can read secrets, defeating the connector's secret-exclusion posture).
 * - listing one node checks optional cluster health coverage; denial warns without disabling pod
 *   monitoring.
 * A network/timeout error at `/api` means unreachable, and says so in a warning: the most common
 * cause is an egress rule between the platform and the control plane, which is invisible from here
 * and otherwise reported as a bare unreachable with nothing to act on.
 * Injectable `fetchImpl` for testing.
 */
export async function probeKubernetes(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
): Promise<KubernetesProbeResult> {
  const warnings: string[] = [];
  const fail = (): KubernetesProbeResult => ({
    reachable: false,
    canListPods: false,
    secretsDenied: false,
    warnings,
  });

  let client: Awaited<ReturnType<typeof k8sClient>>;
  try {
    client = await k8sClient(config, fetchImpl, lookup);
  } catch (e) {
    // A config error (bad apiUrl, missing credential, SSRF guard) is not a reachable cluster.
    warnings.push(e instanceof Error ? e.message : 'kubernetes connector: configuration error');
    return fail();
  }

  const configuredNamespace = str(config.settings.namespace);
  const namespace = configuredNamespace
    ? validateSegment('namespace', configuredNamespace)
    : undefined;

  let apiStatus: number;
  try {
    apiStatus = await client.kstat('/api');
  } catch (e) {
    // Network/timeout: the control plane did not answer. Distinguish the two, because a timeout
    // against an otherwise correct address is almost always egress filtering rather than a wrong
    // apiUrl, and an operator with no warning at all has nothing to act on.
    warnings.push(
      e instanceof Error && e.name === 'TimeoutError'
        ? 'api server did not answer before the timeout; check egress from the platform to the api server, then the apiUrl'
        : 'api server could not be contacted; check the apiUrl and egress from the platform to the api server',
    );
    return fail();
  }
  if (apiStatus === 401 || apiStatus === 403)
    warnings.push('api server reachable but the token is unauthorized at /api');

  const podPath = namespace
    ? `/api/v1/namespaces/${namespace}/pods?limit=1`
    : '/api/v1/pods?limit=1';
  const podStatus = await client.kstat(podPath);
  const canListPods = podStatus === 200;
  if (podStatus === 403) warnings.push('token lacks pod read; apply the RBAC manifest');

  const secretPath = namespace
    ? `/api/v1/namespaces/${namespace}/secrets?limit=1`
    : '/api/v1/secrets?limit=1';
  const secretStatus = await client.kstat(secretPath);
  const secretsDenied = secretStatus === 403;
  if (secretStatus === 200)
    warnings.push('RBAC allows secret reads; apply the least-privilege manifest');

  try {
    const nodeStatus = await client.kstat('/api/v1/nodes?limit=1');
    if (nodeStatus === 403) warnings.push('token lacks node read; reapply the RBAC manifest');
  } catch {
    warnings.push('node health probe failed');
  }

  return { reachable: true, canListPods, secretsDenied, warnings };
}
