import { expect, test } from 'vitest';
import type { InboundCandidate } from '@sre/connectors';
import { alertEntityCandidates } from '../alert-entities';
import { ClassifyCore } from '../core';
import type { ClassifyHandlerDeps } from '../contracts';

const at = new Date('2026-10-20T00:00:00.000Z');
const identities = (text: string) =>
  alertEntityCandidates(text, at).map((candidate) => [
    candidate.kind,
    candidate.scope.namespace ?? null,
    candidate.stableId,
  ]);

test.each([
  [
    'Deployment edge-proxy/edge-proxy-edge has not matched the expected number of replicas.',
    [['workload', 'edge-proxy', 'edge-proxy-edge']],
  ],
  [
    'Job trading/binance-trading-bot-migrate failed to complete.',
    [['workload', 'trading', 'binance-trading-bot-migrate']],
  ],
  [
    'Pod argocd/argocd-repo-server-7c4584b84-sp9ww has been in a non-ready state for longer than 15 minutes.',
    [['workload', 'argocd', 'argocd-repo-server-7c4584b84-sp9ww']],
  ],
  [
    '27% throttling of CPU in namespace argocd for container redis in pod argocd-redis-68869f4989-pfk9h.',
    [['workload', 'argocd', 'argocd-redis-68869f4989-pfk9h']],
  ],
  [
    'pod/argocd-redis-68869f4989-pfk9h in namespace argocd on container redis has been in waiting state for longer than 1 hour.',
    [['workload', 'argocd', 'argocd-redis-68869f4989-pfk9h']],
  ],
  [
    'pod cloudflared-5d9f in namespace edge has been not ready.',
    [['workload', 'edge', 'cloudflared-5d9f']],
  ],
  // The namespace must sit on the same line as the pod it scopes.
  ['pod cloudflared-5d9f in\nnamespace edge is not ready.', []],
  [
    'Probe failed for http://sre-platform-api.sre-platform.svc.cluster.local:3000/healthz',
    [['endpoint', 'sre-platform', 'sre-platform-api']],
  ],
  [
    'etcd cluster "kube-etcd": member communication with instance 192.168.1.202:2381 is slow.',
    [['node', null, '192.168.1.202']],
  ],
  [
    '[FIRING:1] NodeCPUSaturation monitoring (node-exporter)\nCPU on 192.168.1.203:9100 is saturated.',
    [['node', null, '192.168.1.203']],
  ],
])('%s', (text, expected) => {
  expect(identities(text)).toEqual(expected);
});

test('the exporter namespace in a node alert heading never becomes an identity', () => {
  const candidates = alertEntityCandidates(
    '[FIRING:1] NodeMemoryHighUtilization monitoring\nInstance 192.168.1.203:9100 memory is 95% used.',
    at,
  );
  expect(JSON.stringify(candidates)).not.toContain('monitoring');
  expect(candidates[0]).toMatchObject({
    kind: 'node',
    provenance: { kind: 'provider_label', source: 'alert_text' },
    confidence: 70,
    completeness: 'partial',
  });
});

test('a named resource suppresses bare addresses, duplicates collapse, and output is capped', () => {
  expect(
    identities('Pod argocd/a on 10.0.0.1:9100. Pod argocd/a restarted. Pod argocd/a.'),
  ).toEqual([['workload', 'argocd', 'a']]);
  const many = Array.from({ length: 8 }, (_, index) => `Pod ns/pod-${index}`).join('\n');
  expect(alertEntityCandidates(many, at)).toHaveLength(5);
});

test('prose without an exact identity yields nothing', () => {
  expect(alertEntityCandidates('checkout is slow; deploy 1.2.3 went out', at)).toEqual([]);
});

test('Slack signals carry alert-text entities from bots, never from a person', () => {
  const core = new ClassifyCore({} as ClassifyHandlerDeps);
  const message = (author: InboundCandidate['author']) =>
    ({
      externalId: '1.0',
      channel: 'C07EWAS8132',
      author,
      text: 'Pod argocd/argocd-repo-server-7c4584b84-sp9ww is not ready.',
      raw: null,
      signalState: 'firing',
      eventKey: 'event',
      contentHash: 'hash',
      eventAt: at.toISOString(),
    }) as InboundCandidate;
  expect(core.signalsFor(message('bot'))[0]?.affectedEntities?.map((c) => c.stableId)).toEqual([
    'argocd-repo-server-7c4584b84-sp9ww',
  ]);
  expect(core.signalsFor(message('human'))[0]).not.toHaveProperty('affectedEntities');
});

test('a long hyphen run is scanned within a bound and a name past it is ignored', () => {
  const started = performance.now();
  // Every `a` starts a label that scans to the end, so the unbounded scan is quadratic.
  const flood = 'a-'.repeat(100_000);
  expect(alertEntityCandidates(`${flood}.svc.cluster.local Pod ns/late`, at)).toEqual([]);
  expect(performance.now() - started).toBeLessThan(2_000);
});
