import { expect, test } from 'vitest';
import { sanitizeProviderUrl } from '../provider-lifecycle/normalize';

const token = 's3cr3t+tok/en=value with space';

test.each([
  ['raw', `https://prom/graph?t=${token}`],
  ['percent-encoded', `https://prom/graph?t=${encodeURIComponent(token)}`],
  ['lowercase hex', `https://prom/graph?t=${encodeURIComponent(token).toLowerCase()}`],
  ['form-encoded', `https://prom/graph?t=${encodeURIComponent(token).replace(/%20/g, '+')}`],
])('removes the connector token in %s form', (_, url) => {
  expect(sanitizeProviderUrl(url, token)).toBe('https://prom/graph?t=[REDACTED]');
});

test('leaves provider content and other query values alone', () => {
  const url = 'https://prom/graph?g0.expr=up%7Bjob%3D%22api%22%7D&user=a%2Bb';
  expect(sanitizeProviderUrl(url, token)).toBe(url);
  expect(sanitizeProviderUrl(url, '')).toBe(url);
});
