import { expect, test } from 'vitest';
import type { DiscoveredTopologyGraph, TopologyRef } from '@sre/contracts';
import { resolveTrafficReference } from '../traffic-reference';
const start = '2026-09-13T00:00:00.000Z',
  at = '2026-09-13T00:02:00.000Z',
  end = '2026-09-13T00:05:00.000Z';
const service: DiscoveredTopologyGraph['entities'][number] = {
  key: 'service-key',
  ref: { authority: 'kubernetes-cluster:one', kind: 'Service', id: 'service-uid' },
  name: 'web-service',
  kind: 'endpoint',
  scope: { cluster: 'kubernetes-cluster:one', namespace: 'web' },
  attributes: { uid: 'service-uid' },
  network: { addresses: ['10.0.0.1'], ports: [8080] },
  stale: false,
  sources: [
    {
      connectorId: 'one',
      connectorName: 'Runtime',
      connectorType: 'kubernetes',
      collection: 'services',
      completeness: 'complete',
      validFrom: start,
      observedAt: end,
    },
  ],
};
const ref: TopologyRef = {
  authority: 'kubernetes-traffic:one',
  kind: 'tcp_address',
  id: '["10.0.0.1",8080]',
};
test('resolves an exact Service address and port only within its observed interval', () => {
  expect(resolveTrafficReference(ref, at, [service])).toBe('service-key');
  expect(resolveTrafficReference(ref, '2026-09-12T23:59:59.000Z', [service])).toBeNull();
  expect(resolveTrafficReference(ref, '2026-09-13T00:05:01.000Z', [service])).toBeNull();
});
test('does not bridge clusters, ports, conflicting targets or missing binding history', () => {
  expect(
    resolveTrafficReference({ ...ref, authority: 'kubernetes-traffic:other' }, at, [service]),
  ).toBeNull();
  expect(resolveTrafficReference({ ...ref, id: '["10.0.0.1",443]' }, at, [service])).toBeNull();
  expect(resolveTrafficReference(ref, at, [service, { ...service, key: 'other-key' }])).toBeNull();
  expect(
    resolveTrafficReference(ref, at, [
      { ...service, sources: service.sources.map((s) => ({ ...s, validFrom: undefined })) },
    ]),
  ).toBeNull();
});
test('a replacement resource cannot claim the earlier address owner’s logs', () => {
  const replacement = {
    ...service,
    key: 'replacement',
    sources: service.sources.map((s) => ({ ...s, validFrom: end })),
  };
  expect(resolveTrafficReference(ref, at, [replacement])).toBeNull();
});
test('server-side peer lookup identifies a Pod without treating its ephemeral port as a listening port', () => {
  const pod = {
    ...service,
    key: 'pod-key',
    ref: { ...service.ref, kind: 'Pod' },
    kind: 'workload' as const,
    name: 'web-one',
    network: { addresses: ['10.0.0.2'], ports: [] },
  };
  expect(
    resolveTrafficReference({ ...ref, kind: 'pod_address', id: '["10.0.0.2"]' }, at, [pod]),
  ).toBe('pod-key');
  expect(
    resolveTrafficReference({ ...ref, kind: 'pod_name', id: '["web","web-one"]' }, at, [pod]),
  ).toBe('pod-key');
  expect(
    resolveTrafficReference({ ...ref, kind: 'pod_name', id: '["other","web-one"]' }, at, [pod]),
  ).toBeNull();
});
test.each(['null', '{}', '"bad"', '["10.0.0.1"]', 'not-json'])(
  'rejects malformed address identity %s',
  (id) => {
    expect(resolveTrafficReference({ ...ref, id }, at, [service])).toBeNull();
  },
);
