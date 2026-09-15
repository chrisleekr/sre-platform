import { randomUUID } from 'node:crypto';
import {
  makeKubernetesConnector,
  makePrometheusConnector,
  makeDatadogConnector,
  makeGitLabConnector,
  makeArgoCdConnector,
  type ConnectorConfig,
  type IDataSourceConnector,
} from '../../packages/connectors/src/index';

/** Real adapters with deterministic provider transports; no external credentials or requests. */
export function topologyProviderFixture(tenantId: string) {
  let prometheusDenied = false;
  const lookup = async () => ['93.184.216.34'];
  const config = (
    type: ConnectorConfig['type'],
    settings: Record<string, unknown>,
  ): ConnectorConfig => ({
    id: randomUUID(),
    tenantId,
    type,
    name: `Test ${type}`,
    settings,
    getCredential: async () =>
      type === 'datadog'
        ? JSON.stringify({ apiKey: 'test-key', appKey: 'test-app' })
        : type === 'prometheus'
          ? JSON.stringify({ type: 'none' })
          : 'test-token',
  });
  const metadata = (name: string, uid: string) => ({ name, uid, namespace: 'production' });
  const k8s = config('kubernetes', { apiUrl: 'https://kubernetes.example.test' });
  const prom = config('prometheus', { baseUrl: 'https://prometheus.example.test' });
  const dd = config('datadog', {});
  const git = config('gitlab', { baseUrl: 'https://git.example.test', groupId: 7 });
  const argo = config('argocd', {
    baseUrl: 'https://argo.example.test',
    account: 'sre-platform',
    applicationsInAnyNamespace: false,
    applications: [{ project: 'default', name: 'checkout' }],
  });
  const repositories = ['team/application', 'team/deployments'].map((fullName, index) => ({
    repositoryId: String(index + 1),
    fullName,
    htmlUrl: `https://git.example.test/${fullName}`,
    defaultBranch: 'main',
    private: true,
    archived: false,
  }));
  git.repositories = {
    resolve: async () => [],
    search: async (query) => repositories.filter((repo) => repo.fullName.includes(query)),
    recentEvents: async () => [],
  };
  const connectors: IDataSourceConnector[] = [
    makeKubernetesConnector(
      k8s,
      (async (input: string | URL | Request) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/kube-system'))
          return Response.json({ metadata: { uid: 'cluster-one' } });
        const items = path.endsWith('/deployments')
          ? [{ metadata: metadata('checkout-api', 'deployment-one') }]
          : path.endsWith('/pods')
            ? [
                {
                  metadata: {
                    ...metadata('reporter-pod', 'reporter-pod-uid'),
                    labels: {
                      'tags.datadoghq.com/service': 'report-exporter',
                      'tags.datadoghq.com/env': 'production',
                    },
                    annotations: {
                      'resource.opentelemetry.io/service.name': 'batch-reporter',
                      'resource.opentelemetry.io/service.namespace': 'reporting',
                      'resource.opentelemetry.io/deployment.environment.name': 'production',
                    },
                  },
                  status: {
                    phase: 'Running',
                    containerStatuses: [{ name: 'reporter', ready: true, state: { running: {} } }],
                  },
                },
                {
                  metadata: {
                    ...metadata('checkout-pod', 'pod-one'),
                    annotations: {
                      'org.opencontainers.image.source':
                        'https://git.example.test/team/application',
                      'org.opencontainers.image.revision': 'a'.repeat(40),
                    },
                    ownerReferences: [
                      { uid: 'deployment-one', kind: 'Deployment', controller: true },
                    ],
                  },
                  status: {
                    phase: 'Running',
                    containerStatuses: [
                      {
                        name: 'api',
                        ready: false,
                        state: { waiting: { reason: 'CrashLoopBackOff' } },
                      },
                    ],
                  },
                },
              ]
            : [];
        return Response.json({ items });
      }) as typeof fetch,
      lookup,
    ),
    makePrometheusConnector(
      prom,
      (async () =>
        prometheusDenied
          ? Response.json({}, { status: 403 })
          : Response.json({
              status: 'success',
              data: {
                activeTargets: [
                  {
                    scrapePool: 'checkout',
                    scrapeUrl: 'https://checkout.example.test/metrics',
                    labels: { job: 'checkout-target' },
                    discoveredLabels: {
                      __meta_kubernetes_pod_uid: 'pod-one',
                      __meta_kubernetes_namespace: 'production',
                    },
                  },
                ],
              },
            })) as unknown as typeof fetch,
      lookup,
    ),
    makeDatadogConnector(dd, (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/hosts'))
        return Response.json({
          host_list: [
            {
              id: 101,
              host_name: 'finance-node',
              last_reported_time: Math.floor(Date.now() / 1000),
              tags_by_source: { user: ['service:finance-worker', 'env:production'] },
            },
          ],
          total_matching: 1,
        });
      if (path.endsWith('/monitor'))
        return Response.json([
          {
            id: 201,
            name: 'Finance errors',
            type: 'metric alert',
            tags: ['service:finance-worker', 'env:production'],
          },
        ]);
      if (path.endsWith('/catalog/entity'))
        return Response.json({
          data: ['settlement', 'bank-gateway'].map((name) => ({
            id: `catalog-${name}`,
            attributes: {
              kind: 'service',
              name,
              namespace: 'finance',
              tags: ['env:production'],
            },
          })),
          meta: { count: 2 },
        });
      if (path.endsWith('/catalog/relation'))
        return Response.json({
          data: [
            {
              id: 'declared-dependency',
              attributes: {
                type: 'RelationTypeDependsOn',
                from: { kind: 'service', name: 'settlement', namespace: 'finance' },
                to: { kind: 'service', name: 'bank-gateway', namespace: 'finance' },
              },
              relationships: {
                fromEntity: { data: { id: 'catalog-settlement' } },
                toEntity: { data: { id: 'catalog-bank-gateway' } },
              },
            },
          ],
          meta: { count: 1 },
        });
      const at = new Date(Date.now() - 1000).toISOString();
      return Response.json({
        data: [
          {
            attributes: {
              service: 'checkout',
              env: 'production',
              trace_id: 'trace-one',
              span_id: 'one',
              parent_id: '0',
              start_timestamp: at,
              attributes: { 'k8s.pod.uid': 'pod-one', 'k8s.namespace.name': 'production' },
            },
          },
          {
            attributes: {
              service: 'payments',
              env: 'production',
              trace_id: 'trace-one',
              span_id: 'two',
              parent_id: 'one',
              start_timestamp: at,
            },
          },
          {
            attributes: {
              service: 'checkout',
              env: 'development',
              trace_id: 'trace-two',
              span_id: 'three',
              parent_id: '0',
              start_timestamp: at,
            },
          },
        ],
      });
    }) as unknown as typeof fetch),
    makeGitLabConnector(
      git,
      (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        if (url.pathname.includes('/repository/commits/'))
          return Response.json({
            id: url.pathname.endsWith('/main') ? 'a'.repeat(40) : url.pathname.split('/').at(-1),
          });
        if (decodeURIComponent(url.pathname).endsWith('/catalog-info.yaml/raw')) {
          if (!decodeURIComponent(url.pathname).includes('/team/application/'))
            return new Response('', { status: 404 });
          return new Response(`apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: catalog-api
spec:
  type: service
  owner: team
  lifecycle: production
  dependsOn: [component:default/catalog-database]
---
apiVersion: backstage.io/v1alpha1
kind: Component
metadata:
  name: catalog-database
spec:
  type: service
  owner: team
  lifecycle: production
`);
        }
        if (url.pathname.includes('/repository/files/'))
          return new Response('kind: Deployment\nmetadata:\n  name: checkout\n');
        return Response.json({}, { status: 404 });
      }) as typeof fetch,
      lookup,
    ),
    makeArgoCdConnector(
      argo,
      (async (input: string | URL | Request) =>
        Response.json(
          String(input).includes('resource-tree')
            ? {
                nodes: [
                  {
                    kind: 'Deployment',
                    name: 'checkout-api',
                    namespace: 'production',
                    uid: 'deployment-one',
                  },
                ],
              }
            : {
                items: [
                  {
                    metadata: { uid: 'argo-application', name: 'checkout', namespace: 'argocd' },
                    spec: {
                      project: 'default',
                      destination: { server: 'https://kubernetes.default.svc' },
                      source: {
                        repoURL: 'https://git.example.test/team/deployments',
                        path: 'apps/checkout',
                      },
                    },
                    status: { sync: { revision: 'c'.repeat(40) } },
                  },
                ],
              },
        )) as typeof fetch,
      lookup,
    ),
  ];
  for (const connector of connectors)
    Object.defineProperty(connector, 'generation', {
      value: { id: connector.id, lifecycleVersion: 0 },
    });
  return {
    configs: [k8s, prom, dd, git, argo],
    connectors,
    denyPrometheus: () => {
      prometheusDenied = true;
    },
  };
}
