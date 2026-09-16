/** Synthetic, typed evidence for the incident guide. */
export function demoIncidentEvidence(openedAt: Date) {
  const metric = (service: string, values: number[]) => ({
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [
        {
          metric: { service },
          values: values.map((value, index) => [
            openedAt.getTime() / 1000 + (index - 4) * 60,
            String(value),
          ]),
        },
      ],
    },
  });
  return [
    {
      id: crypto.randomUUID(),
      tool: 'prometheus_query_range',
      latencyMs: 417,
      input: { query: 'checkout_request_duration_seconds{quantile="0.99"}' },
      output: metric('checkout-api', [0.8, 0.8, 1.1, 1.8, 2.2, 2.4]),
      outcome: 'data',
    },
    {
      id: crypto.randomUUID(),
      tool: 'argocd_get_application_logs',
      latencyMs: 940,
      input: { name: 'checkout-api', podName: 'checkout-api-7d9f' },
      output: {
        log: '14:03:11 pool wait exceeded 1900ms; active workers=32; pool limit=8\n14:03:12 request deadline approaching; queued workers=24',
      },
      outcome: 'data',
    },
    {
      id: crypto.randomUUID(),
      tool: 'prometheus_query_range',
      latencyMs: 231,
      input: { query: 'payments_request_duration_seconds{quantile="0.99"}' },
      output: metric('payments-gateway', [0.12, 0.12, 0.12, 0.12, 0.12, 0.12]),
      outcome: 'data',
    },
    {
      id: crypto.randomUUID(),
      tool: 'kubernetes_list_pods',
      latencyMs: 233,
      input: { namespace: 'checkout' },
      output: [{ name: 'checkout-api-7d9f', status: 'CrashLoopBackOff', lastReason: 'OOMKilled' }],
      outcome: 'data',
    },
    {
      id: crypto.randomUUID(),
      tool: 'gitlab_read_file',
      latencyMs: 302,
      input: { projectId: 'acme/checkout-config', path: 'pool.yaml', ref: 'main' },
      output: { error: 'Project is outside the configured connection scope.' },
      outcome: 'error',
    },
    {
      id: crypto.randomUUID(),
      tool: 'prometheus_query_range',
      latencyMs: 128,
      input: { query: 'checkout_pool_limit_previous_release' },
      output: null,
      outcome: 'no_data',
    },
  ];
}
