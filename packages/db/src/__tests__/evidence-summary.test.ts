import { expect, test } from 'vitest';
import { evidenceSummary } from '../tool-call-repo/summary';

test('matches explicit operations and refuses generic API paths and unknown suffixes', () => {
  expect(
    evidenceSummary('kubernetes_AAAAAAAAAAAAAAAAAAAAAA_get_pod_logs', {
      namespace: 'prod',
      name: 'checkout',
      container: 'api',
      token: 'not-public',
    }),
  ).toBe('namespace: prod · name: checkout · container: api');
  expect(evidenceSummary('prometheus_api_get', { path: '/secret', query: 'private' })).toBeNull();
  expect(evidenceSummary('unexpected_prometheus_query_range', { query: 'private' })).toBeNull();
  expect(evidenceSummary('gitlab_search_projects', { query: { secret: 'private' } })).toBeNull();
});
test('keeps retained scalar values verbatim and bounds Unicode without splitting codepoints', () => {
  const result = evidenceSummary('prometheus_query_range', {
    query: 'Bearer abcdefghijklmnop ' + '😀'.repeat(300),
  });
  expect(result).toContain('Bearer abcdefghijklmnop');
  expect([...(result ?? '')]).toHaveLength(200);
  expect(result).not.toMatch(/[\ud800-\udbff]$/);
});

test('summarizes StatusCake checks by test id and type', () => {
  const key = 'AAAAAAAAAAAAAAAAAAAAAA';
  expect(evidenceSummary(`statuscake_${key}_get_test`, { type: 'heartbeat', id: '5' })).toBe(
    'type: heartbeat · id: 5',
  );
  expect(evidenceSummary(`statuscake_${key}_get_uptime_periods`, { id: '77' })).toBe('id: 77');
  expect(evidenceSummary(`statuscake_${key}_api_get`, { path: 'v1/uptime' })).toBeNull();
});
