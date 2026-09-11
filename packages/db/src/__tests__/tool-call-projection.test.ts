import { describe, expect, test } from 'vitest';
import { projectEvidence, safeEvidenceReference } from '../tool-call-repo';

describe('projectEvidence', () => {
  test('projects persisted Prometheus matrix samples into a numeric series', () => {
    expect(
      projectEvidence(
        'prometheus_instance_query_range',
        { query: 'rate(errors_total[5m])', start: 'now-1h', end: 'now' },
        {
          status: 'success',
          data: {
            resultType: 'matrix',
            result: [
              {
                metric: { __name__: 'errors_total', service: 'checkout' },
                values: [
                  [1_787_700_000, '1.5'],
                  [1_787_700_060, '2.5'],
                ],
              },
            ],
          },
        },
      ),
    ).toEqual({
      kind: 'time_series',
      source: 'prometheus',
      query: 'rate(errors_total[5m])',
      from: '2026-08-25T23:20:00.000Z',
      to: '2026-08-25T23:21:00.000Z',
      series: [
        {
          name: 'errors_total {service=checkout}',
          unit: null,
          points: [
            { timestamp: '2026-08-25T23:20:00.000Z', value: 1.5 },
            { timestamp: '2026-08-25T23:21:00.000Z', value: 2.5 },
          ],
        },
      ],
    });
  });

  test('projects persisted Datadog points and keeps discrete output as facts', () => {
    const metric = projectEvidence(
      'datadog_instance_query_metrics',
      { query: 'avg:system.cpu.user{service:checkout}', from: 'now-1h', to: 'now' },
      {
        series: [
          {
            display_name: 'system.cpu.user',
            metric: 'system.cpu.user',
            scope: 'service:checkout',
            unit: [{ name: 'percent' }],
            pointlist: [[1_787_700_000_000, 73]],
          },
          {
            display_name: 'system.cpu.user',
            metric: 'system.cpu.user',
            scope: 'service:payments',
            unit: [{ name: 'percent' }],
            pointlist: [[1_787_700_000_000, 51]],
          },
        ],
      },
    );
    expect(metric).toEqual({
      kind: 'time_series',
      source: 'datadog',
      query: 'avg:system.cpu.user{service:checkout}',
      from: '2026-08-25T23:20:00.000Z',
      to: '2026-08-25T23:20:00.000Z',
      series: [
        {
          name: 'system.cpu.user {service:checkout}',
          unit: 'percent',
          points: [{ timestamp: '2026-08-25T23:20:00.000Z', value: 73 }],
        },
        {
          name: 'system.cpu.user {service:payments}',
          unit: 'percent',
          points: [{ timestamp: '2026-08-25T23:20:00.000Z', value: 51 }],
        },
      ],
    });

    expect(
      projectEvidence('kubernetes_list_pods', {}, { items: [{ name: 'api', ready: true }] }),
    ).toEqual({
      kind: 'facts',
      columns: ['name', 'ready'],
      rows: [{ name: 'api', ready: true }],
    });
  });

  test('never invents a time series from non-numeric provider output', () => {
    expect(
      projectEvidence(
        'prometheus_instance_query_range',
        { query: 'up' },
        { data: { resultType: 'matrix', result: [{ values: [['bad', 'not-a-number']] }] } },
      ),
    ).toEqual({
      kind: 'facts',
      columns: ['data.resultType'],
      rows: [{ 'data.resultType': 'matrix' }],
    });

    const prometheus = projectEvidence(
      'prometheus_instance_query_range',
      { query: 'up' },
      {
        data: {
          resultType: 'matrix',
          result: [
            {
              values: [
                [1_787_700_000, null],
                ['', '2'],
                [false, '3'],
                ['1787700060', '4.5'],
              ],
            },
          ],
        },
      },
    );
    expect(prometheus).toMatchObject({
      kind: 'time_series',
      series: [{ points: [{ timestamp: '2026-08-25T23:21:00.000Z', value: 4.5 }] }],
    });

    const datadog = projectEvidence(
      'datadog_instance_query_metrics',
      { query: 'avg:system.load.1{*}' },
      {
        series: [
          {
            pointlist: [
              [1_787_700_000_000, null],
              ['', 2],
              [true, 3],
              ['1787700060000', '4.5'],
            ],
          },
        ],
      },
    );
    expect(datadog).toMatchObject({
      kind: 'time_series',
      series: [{ points: [{ timestamp: '2026-08-25T23:21:00.000Z', value: 4.5 }] }],
    });
    expect(JSON.stringify([prometheus, datadog])).not.toContain('1970-01-01');
  });

  test('projects scalar and known discrete arrays without forcing responders into raw JSON', () => {
    expect(projectEvidence('prometheus_label_values', {}, { data: ['api', 'worker'] })).toEqual({
      kind: 'facts',
      columns: ['value'],
      rows: [{ value: 'api' }, { value: 'worker' }],
    });
    expect(
      projectEvidence('kubernetes_list_events', {}, { events: [{ reason: 'BackOff' }] }),
    ).toEqual({
      kind: 'facts',
      columns: ['reason'],
      rows: [{ reason: 'BackOff' }],
    });
    expect(projectEvidence('kubernetes_list_api_resources', {}, { resources: [] })).toEqual({
      kind: 'facts',
      columns: ['value'],
      rows: [],
    });
    expect(
      projectEvidence(
        'argocd_instance_list_applications',
        {},
        {
          applications: [{ name: 'checkout', health: 'Degraded' }],
        },
      ),
    ).toEqual({
      kind: 'facts',
      columns: ['name', 'health'],
      rows: [{ name: 'checkout', health: 'Degraded' }],
    });
    expect(
      projectEvidence(
        'github_instance_list_workflow_runs',
        {},
        {
          total_count: 1,
          workflow_runs: [{ id: 42, conclusion: 'failure' }],
        },
      ),
    ).toEqual({
      kind: 'facts',
      columns: ['id', 'conclusion'],
      rows: [{ id: 42, conclusion: 'failure' }],
    });
    expect(
      projectEvidence('kubernetes_instance_get_pod_logs', {}, { log: 'line 1\nline 2' }),
    ).toEqual({ kind: 'raw' });
  });

  test('projects code intelligence into revision-pinned source evidence', () => {
    const revision = 'a'.repeat(40);
    expect(
      projectEvidence(
        'investigate_code',
        { stackTrace: '/workspace/src/index.ts:42:3' },
        {
          status: 'located',
          artifacts: [
            {
              dataSourceName: 'Kubernetes production',
              identity: `registry.example/app@sha256:${'b'.repeat(64)}`,
              namespace: 'checkout',
              workload: 'checkout-abc',
              container: 'app',
              revision,
              provenance: 'declared',
            },
          ],
          revisions: [
            {
              repository: { fullName: 'acme/checkout' },
              role: 'application_source',
              basis: 'runtime_annotation',
              strength: 'declared',
              revision,
              providerUrl: `https://github.com/acme/checkout/commit/${revision}`,
              deployedAt: null,
            },
          ],
          evidence: [
            {
              repository: { fullName: 'acme/checkout' },
              revision,
              strength: 'declared',
              path: 'src/index.ts',
              startLine: 32,
              endLine: 52,
              excerpt: '42: throw new Error()',
              providerUrl: `https://github.com/acme/checkout/blob/${revision}/src/index.ts#L32-L52`,
              changedFromPreviousRevision: true,
            },
          ],
          uncertainties: [],
          requiredSetup: [],
        },
      ),
    ).toMatchObject({
      kind: 'code',
      status: 'located',
      revisions: [
        {
          repository: 'acme/checkout',
          basis: 'runtime_annotation',
          strength: 'declared',
          revision,
        },
      ],
      matches: [
        {
          repository: 'acme/checkout',
          revision,
          path: 'src/index.ts',
          excerpt: '42: throw new Error()',
          changedFromPreviousRevision: true,
        },
      ],
    });
  });

  test('accepts references only within the configured connector base path', () => {
    expect(
      safeEvidenceReference(
        {
          commits: [{ web_url: 'https://gitlab.example.com/root/group/project/-/commit/abc' }],
        },
        'https://gitlab.example.com/root',
      ),
    ).toBe('https://gitlab.example.com/root/group/project/-/commit/abc');
    expect(
      safeEvidenceReference(
        { url: 'https://attacker.example/phish' },
        'https://gitlab.example.com/root',
      ),
    ).toBeNull();
    expect(
      safeEvidenceReference(
        { url: 'https://gitlab.example.com/other/project' },
        'https://gitlab.example.com/root',
      ),
    ).toBeNull();
  });
});
