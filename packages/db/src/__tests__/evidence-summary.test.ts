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
test('re-scrubs retained scalar values and bounds Unicode without splitting codepoints', () => {
  const result = evidenceSummary('prometheus_query_range', {
    query: 'Bearer abcdefghijklmnop ' + '😀'.repeat(300),
  });
  expect(result).not.toContain('abcdefghijklmnop');
  expect(result).toContain('[REDACTED]');
  expect([...(result ?? '')]).toHaveLength(200);
  expect(result).not.toMatch(/[\ud800-\udbff]$/);
});
