// Corpus for the model-facing TOON encoding guards.
//
// Six recorded-output shapes mirroring the tools that dominate real triage traffic. They are NESTED
// on purpose, and several encode to LIST form rather than a table: an array of uniform objects
// becomes a single-indent-level table with no list markers at all, which is exactly the shape that
// would let the alignment guard pass vacuously. Real tool payloads nest and vary per element (a pod
// carries labels and containers; a deploy carries commits carrying files), which is where indent
// width is actually paid and where list-item alignment is actually readable or not.
//
// These are transcribed from the shape of real provider responses: keep them representative when
// editing, and keep every sample producing list items, which the guard now enforces per sample.
// Values are synthetic.

export interface ToonEncodingSample {
  tool: string;
  evidenceId: string;
  data: unknown;
}

const kubernetesListPods = {
  namespace: 'checkout-prod',
  cluster: 'prod-apse2',
  pods: [
    {
      name: 'checkout-api-7d9f6c8b4d-4x2ql',
      phase: 'Running',
      nodeName: 'ip-10-42-13-201.ap-southeast-2.compute.internal',
      podIP: '10.42.13.88',
      startTime: '2026-08-31T22:14:07Z',
      restartCount: 0,
      labels: {
        'app.kubernetes.io/name': 'checkout-api',
        'app.kubernetes.io/instance': 'checkout-api-prod',
        'app.kubernetes.io/component': 'api',
        'app.kubernetes.io/part-of': 'checkout',
        'app.kubernetes.io/managed-by': 'argocd',
        'app.kubernetes.io/version': '2026.8.31-4',
        'pod-template-hash': '7d9f6c8b4d',
      },
      containers: [
        {
          name: 'api',
          image: 'registry.internal/checkout-api:2026.8.31-4',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: '2026-08-31T22:14:19Z' } },
          resources: {
            requests: { cpu: '500m', memory: '512Mi' },
            limits: { cpu: '2', memory: '1Gi' },
          },
        },
        {
          name: 'envoy',
          image: 'registry.internal/envoy:1.31.2',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: '2026-08-31T22:14:12Z' } },
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
          },
        },
      ],
      conditions: [
        { type: 'Initialized', status: 'True', lastTransitionTime: '2026-08-31T22:14:08Z' },
        { type: 'Ready', status: 'True', lastTransitionTime: '2026-08-31T22:14:21Z' },
        { type: 'ContainersReady', status: 'True', lastTransitionTime: '2026-08-31T22:14:21Z' },
      ],
    },
    {
      name: 'checkout-api-7d9f6c8b4d-9htz7',
      phase: 'Running',
      nodeName: 'ip-10-42-9-14.ap-southeast-2.compute.internal',
      podIP: '10.42.9.51',
      startTime: '2026-08-31T22:14:07Z',
      restartCount: 3,
      labels: {
        'app.kubernetes.io/name': 'checkout-api',
        'app.kubernetes.io/instance': 'checkout-api-prod',
        'app.kubernetes.io/component': 'api',
        'app.kubernetes.io/part-of': 'checkout',
        'app.kubernetes.io/managed-by': 'argocd',
        'app.kubernetes.io/version': '2026.8.31-4',
        'pod-template-hash': '7d9f6c8b4d',
      },
      containers: [
        {
          name: 'api',
          image: 'registry.internal/checkout-api:2026.8.31-4',
          ready: false,
          restartCount: 3,
          state: {
            waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s restarting container' },
          },
          lastState: {
            terminated: {
              reason: 'OOMKilled',
              exitCode: 137,
              startedAt: '2026-09-01T01:02:44Z',
              finishedAt: '2026-09-01T01:07:31Z',
            },
          },
          resources: {
            requests: { cpu: '500m', memory: '512Mi' },
            limits: { cpu: '2', memory: '1Gi' },
          },
        },
        {
          name: 'envoy',
          image: 'registry.internal/envoy:1.31.2',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: '2026-08-31T22:14:12Z' } },
          resources: {
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '500m', memory: '256Mi' },
          },
        },
      ],
      conditions: [
        { type: 'Initialized', status: 'True', lastTransitionTime: '2026-08-31T22:14:08Z' },
        { type: 'Ready', status: 'False', lastTransitionTime: '2026-09-01T01:07:32Z' },
        { type: 'ContainersReady', status: 'False', lastTransitionTime: '2026-09-01T01:07:32Z' },
      ],
    },
    {
      name: 'checkout-worker-5c47bd9f8-t6kmp',
      phase: 'Running',
      nodeName: 'ip-10-42-13-201.ap-southeast-2.compute.internal',
      podIP: '10.42.13.104',
      startTime: '2026-08-30T04:41:55Z',
      restartCount: 0,
      labels: {
        'app.kubernetes.io/name': 'checkout-worker',
        'app.kubernetes.io/instance': 'checkout-worker-prod',
        'app.kubernetes.io/component': 'worker',
        'app.kubernetes.io/part-of': 'checkout',
        'app.kubernetes.io/managed-by': 'argocd',
        'app.kubernetes.io/version': '2026.8.29-1',
        'pod-template-hash': '5c47bd9f8',
      },
      containers: [
        {
          name: 'worker',
          image: 'registry.internal/checkout-worker:2026.8.29-1',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: '2026-08-30T04:42:03Z' } },
          resources: {
            requests: { cpu: '250m', memory: '256Mi' },
            limits: { cpu: '1', memory: '512Mi' },
          },
        },
      ],
      conditions: [
        { type: 'Initialized', status: 'True', lastTransitionTime: '2026-08-30T04:41:56Z' },
        { type: 'Ready', status: 'True', lastTransitionTime: '2026-08-30T04:42:05Z' },
        { type: 'ContainersReady', status: 'True', lastTransitionTime: '2026-08-30T04:42:05Z' },
      ],
    },
  ],
};

const kubernetesPodLogs = {
  namespace: 'checkout-prod',
  pod: 'checkout-api-7d9f6c8b4d-9htz7',
  container: 'api',
  sinceSeconds: 900,
  truncated: false,
  entries: [
    {
      timestamp: '2026-09-01T01:02:51.204Z',
      level: 'info',
      message: 'server listening',
      fields: { port: 8080, revision: '2026.8.31-4', pid: 1 },
    },
    {
      timestamp: '2026-09-01T01:03:12.881Z',
      level: 'warn',
      message: 'upstream latency above threshold',
      fields: {
        route: 'POST /v1/checkout/session',
        upstream: 'payments-api',
        latencyMs: 2481,
        thresholdMs: 1500,
        requestId: '01J9Y4K2QW7M3ZC5N8T1',
      },
    },
    {
      timestamp: '2026-09-01T01:04:02.117Z',
      level: 'error',
      message: 'checkout session persist failed',
      fields: {
        route: 'POST /v1/checkout/session',
        statusCode: 500,
        latencyMs: 5011,
        requestId: '01J9Y4M8BD2P6RH0V3XA',
        error: { name: 'TimeoutError', code: 'ETIMEDOUT', retryable: true },
      },
    },
    {
      timestamp: '2026-09-01T01:05:44.630Z',
      level: 'error',
      message: 'connection pool exhausted',
      fields: {
        route: 'POST /v1/checkout/session',
        statusCode: 503,
        latencyMs: 30014,
        requestId: '01J9Y4PGR5N9WQ2E7KTD',
        error: { name: 'PoolExhaustedError', code: 'POOL_TIMEOUT', retryable: false },
      },
    },
    {
      timestamp: '2026-09-01T01:07:29.902Z',
      level: 'fatal',
      message: 'heap limit exceeded, terminating',
      fields: {
        heapUsedMb: 1019,
        heapLimitMb: 1024,
        rssMb: 1043,
        requestId: '01J9Y4TCE1J4XB8S0MFN',
      },
    },
  ],
};

const listDeploys = {
  service: 'checkout-api',
  environment: 'production',
  windowHours: 24,
  deploys: [
    {
      id: 'dep-9f2c41',
      revision: '2026.8.31-4',
      status: 'succeeded',
      startedAt: '2026-08-31T22:11:40Z',
      finishedAt: '2026-08-31T22:15:02Z',
      trigger: { kind: 'merge_request', reference: '!482', pipelineId: 91422 },
      commits: [
        {
          sha: '4f1c0a9e7b2d5c81',
          subject: 'raise checkout session cache TTL to 15m',
          authorEmail: 'ana@example.com',
          files: [
            { path: 'src/session/cache.ts', status: 'modified', additions: 18, deletions: 4 },
            { path: 'src/config/defaults.ts', status: 'modified', additions: 2, deletions: 2 },
          ],
        },
        {
          sha: 'b73e8d24f095a1cc',
          subject: 'drop redundant payments retry wrapper',
          authorEmail: 'kenji@example.com',
          files: [
            { path: 'src/payments/retry.ts', status: 'deleted', additions: 0, deletions: 61 },
            { path: 'src/payments/client.ts', status: 'modified', additions: 7, deletions: 23 },
          ],
        },
      ],
    },
    {
      id: 'dep-7a10bb',
      revision: '2026.8.29-1',
      status: 'succeeded',
      startedAt: '2026-08-29T03:55:12Z',
      finishedAt: '2026-08-29T03:58:47Z',
      trigger: { kind: 'merge_request', reference: '!479', pipelineId: 91188 },
      commits: [
        {
          sha: 'c92aa77e10bf3d40',
          subject: 'add saturation dashboards for worker queue',
          authorEmail: 'ana@example.com',
          files: [
            { path: 'infra/dashboards/worker.yaml', status: 'added', additions: 140, deletions: 0 },
          ],
        },
      ],
    },
    {
      id: 'dep-5c8e02',
      revision: '2026.8.28-2',
      status: 'rolled_back',
      startedAt: '2026-08-28T11:02:09Z',
      finishedAt: '2026-08-28T11:24:55Z',
      trigger: { kind: 'manual', reference: 'hotfix', pipelineId: 91031 },
      commits: [
        {
          sha: 'e4b1d6390cf7a285',
          subject: 'switch session store to new pool defaults',
          authorEmail: 'kenji@example.com',
          files: [
            { path: 'src/db/pool.ts', status: 'modified', additions: 31, deletions: 12 },
            { path: 'src/db/pool.test.ts', status: 'modified', additions: 44, deletions: 3 },
          ],
        },
      ],
    },
  ],
};

const prometheusMetricSeries = {
  query:
    'sum by (pod, route) (rate(http_request_duration_seconds_count{service="checkout-api"}[5m]))',
  resultType: 'matrix',
  step: '60s',
  series: [
    {
      metric: {
        pod: 'checkout-api-7d9f6c8b4d-4x2ql',
        route: 'POST /v1/checkout/session',
        job: 'kubernetes-pods',
        namespace: 'checkout-prod',
      },
      values: [
        [1756688400, '41.2'],
        [1756688460, '43.8'],
        [1756688520, '44.1'],
        [1756688580, '58.6'],
        [1756688640, '62.9'],
        [1756688700, '61.4'],
      ],
    },
    {
      metric: {
        pod: 'checkout-api-7d9f6c8b4d-9htz7',
        route: 'POST /v1/checkout/session',
        job: 'kubernetes-pods',
        namespace: 'checkout-prod',
      },
      values: [
        [1756688400, '40.7'],
        [1756688460, '39.2'],
        [1756688520, '18.5'],
        [1756688580, '0'],
        [1756688640, '0'],
        [1756688700, '0'],
      ],
    },
    {
      metric: {
        pod: 'checkout-worker-5c47bd9f8-t6kmp',
        route: 'internal/consume',
        job: 'kubernetes-pods',
        namespace: 'checkout-prod',
      },
      values: [
        [1756688400, '12.0'],
        [1756688460, '12.4'],
        [1756688520, '19.8'],
        [1756688580, '27.3'],
        [1756688640, '31.1'],
        [1756688700, '33.6'],
      ],
    },
  ],
};

const topologyGraph = {
  root: { id: 'svc:checkout-api', kind: 'service' },
  depth: 2,
  nodes: [
    {
      id: 'svc:checkout-api',
      kind: 'service',
      name: 'checkout-api',
      attributes: { tier: 'edge', owner: 'payments-platform', runtime: 'bun', sloTarget: '99.9' },
    },
    {
      id: 'svc:payments-api',
      kind: 'service',
      name: 'payments-api',
      attributes: { tier: 'core', owner: 'payments-platform', runtime: 'go', sloTarget: '99.95' },
    },
    {
      id: 'db:checkout-primary',
      kind: 'datastore',
      name: 'checkout-primary',
      attributes: { engine: 'postgres', version: '16.4', instanceClass: 'db.r6g.xlarge' },
    },
    {
      id: 'cache:checkout-sessions',
      kind: 'datastore',
      name: 'checkout-sessions',
      attributes: { engine: 'valkey', version: '8.0', instanceClass: 'cache.r7g.large' },
    },
    {
      id: 'svc:notifications',
      kind: 'service',
      name: 'notifications',
      attributes: { tier: 'async', owner: 'growth', runtime: 'node', sloTarget: '99.5' },
    },
  ],
  edges: [
    { from: 'svc:checkout-api', to: 'svc:payments-api', kind: 'calls', confidence: 0.97 },
    { from: 'svc:checkout-api', to: 'db:checkout-primary', kind: 'reads_writes', confidence: 1 },
    {
      from: 'svc:checkout-api',
      to: 'cache:checkout-sessions',
      kind: 'reads_writes',
      confidence: 1,
    },
    { from: 'svc:notifications', to: 'svc:checkout-api', kind: 'calls', confidence: 0.62 },
  ],
};

const runbookSearchHits = {
  query: 'checkout session persist timeout pool exhausted',
  matched: 3,
  hits: [
    {
      id: 'rb-0c41',
      title: 'checkout-api connection pool exhaustion after cache TTL change',
      score: 0.881,
      occurrenceCount: 4,
      verified: true,
      lastSeenAt: '2026-07-19T09:14:00Z',
      steps: [
        { order: 1, action: 'confirm pool saturation on the primary', expected: 'waiting > 0' },
        { order: 2, action: 'roll back the most recent cache TTL change', expected: 'waiting → 0' },
        { order: 3, action: 'verify checkout session error rate returns to baseline' },
      ],
      source: { incidentId: 'inc-2026-07-19-002', service: 'checkout-api', severity: 'sev2' },
    },
    {
      id: 'rb-19ae',
      title: 'checkout-api OOMKilled under session cache growth',
      score: 0.774,
      occurrenceCount: 2,
      verified: false,
      lastSeenAt: '2026-06-02T21:40:00Z',
      steps: [
        { order: 1, action: 'compare heapUsedMb against the container memory limit' },
        { order: 2, action: 'raise the memory limit or bound the cache entry count' },
      ],
      source: { incidentId: 'inc-2026-06-02-011', service: 'checkout-api', severity: 'sev3' },
    },
    {
      id: 'rb-33f7',
      title: 'payments-api latency propagating into checkout timeouts',
      score: 0.612,
      occurrenceCount: 7,
      verified: true,
      lastSeenAt: '2026-08-11T02:03:00Z',
      steps: [
        { order: 1, action: 'check payments-api p99 for the same window' },
        { order: 2, action: 'if elevated, page the payments-platform on-call' },
      ],
      source: { incidentId: 'inc-2026-08-11-004', service: 'payments-api', severity: 'sev2' },
    },
  ],
};

/** Six nested recorded tool outputs that encode to TOON list form, the shape the alignment guard checks. */
export const TOON_ENCODING_SAMPLES: ToonEncodingSample[] = [
  {
    tool: 'kubernetes_list_pods',
    evidenceId: '11111111-1111-4111-8111-111111111101',
    data: kubernetesListPods,
  },
  {
    tool: 'kubernetes_pod_logs',
    evidenceId: '11111111-1111-4111-8111-111111111102',
    data: kubernetesPodLogs,
  },
  {
    tool: 'list_deploys',
    evidenceId: '11111111-1111-4111-8111-111111111103',
    data: listDeploys,
  },
  {
    tool: 'prometheus_query_range',
    evidenceId: '11111111-1111-4111-8111-111111111104',
    data: prometheusMetricSeries,
  },
  {
    tool: 'topology_blast_radius',
    evidenceId: '11111111-1111-4111-8111-111111111105',
    data: topologyGraph,
  },
  {
    tool: 'search_runbooks',
    evidenceId: '11111111-1111-4111-8111-111111111106',
    data: runbookSearchHits,
  },
];
