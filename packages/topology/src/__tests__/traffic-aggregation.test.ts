import { expect, test } from 'vitest';
import type { DiscoveredTopologyGraph } from '@sre/contracts';
import { discoveredOperationalTopology } from '../operational';
import { resolveDiscoveredTopology } from '../discovery';

const at = '2026-09-13T00:05:00.000Z',
  older = '2026-09-13T00:01:00.000Z',
  start = '2026-09-13T00:00:00.000Z';
const source = (observedAt = at) => ({
  connectorId: 'runtime',
  connectorName: 'Runtime',
  connectorType: 'kubernetes',
  collection: 'pods',
  completeness: 'complete' as const,
  observedAt,
  validFrom: start,
});
const node = (
  key: string,
  kind: 'workload' | 'service' = 'workload',
): DiscoveredTopologyGraph['entities'][number] => ({
  key,
  ref: { authority: 'cluster', kind: 'Pod', id: key },
  kind,
  name: key,
  scope: {},
  attributes: {},
  sources: [source()],
  stale: false,
});
const relation = (
  from: string,
  to: string,
  kind: 'calls' | 'owns' | 'runs_on',
  observedAt = at,
): DiscoveredTopologyGraph['relations'][number] => ({
  key: `${from}-${to}-${kind}`,
  from: { authority: 'cluster', kind: 'Pod', id: from },
  to: { authority: 'cluster', kind: 'Pod', id: to },
  fromKey: from,
  toKey: to,
  kind,
  evidence: kind === 'calls' ? 'observed' : 'provider_reference',
  description: '',
  sources: [source(observedAt)],
  stale: false,
  ...(kind === 'calls'
    ? {
        attributes: {
          parser: 'grpc-client',
          outcome: observedAt === at ? 'response_recorded' : 'attempt_recorded',
        },
      }
    : {}),
});
test.each([false, true])(
  'duplicate source samples retain the outcome and evidence time of the newest sample: %s',
  (reverse) => {
    const newest = '2026-09-13T00:05:50.000Z';
    const previous = '2026-09-13T00:05:10.000Z';
    const caller = node('caller'),
      target = node('target');
    const sample = (connectorId: string, observedAt: string, outcome: string) => ({
      connectorId,
      connectorName: connectorId,
      connectorType: 'datadog',
      key: 'logs',
      observedAt: newest,
      attemptedAt: newest,
      completeness: 'partial' as const,
      issue: 'sampling' as const,
      entities: [caller, target].map((value) => ({ value, observedAt: newest })),
      relations: [
        {
          observedAt,
          value: {
            ...relation('caller', 'target', 'calls'),
            evidenceAt: observedAt,
            scope: { observationWindow: at },
            attributes: { parser: 'grpc-client', outcome, windowEnd: observedAt },
          },
        },
      ],
    });
    const samples = [
      sample('first', newest, 'response_recorded'),
      sample('second', previous, 'attempt_recorded'),
    ];
    const graph = resolveDiscoveredTopology(
      reverse ? samples.reverse() : samples,
      Date.parse(newest),
    );
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({
      evidenceAt: newest,
      attributes: { outcome: 'response_recorded', windowEnd: newest },
    });
    expect(graph.relations[0]!.sources).toHaveLength(2);
    expect(discoveredOperationalTopology(graph).relations[0]).toMatchObject({
      observedAt: newest,
      attributes: { outcome: 'response_recorded', windowEnd: newest },
    });
  },
);
test.each([false, true])(
  'aggregated and projected calls keep the latest matching outcome regardless of input order: %s',
  (reverse) => {
    const graph: DiscoveredTopologyGraph = {
      entities: [
        node('controller'),
        node('pod-a'),
        node('pod-z'),
        node('backend'),
        node('caller-service', 'service'),
        node('target-service', 'service'),
      ],
      relations: [
        relation('controller', 'pod-a', 'owns'),
        relation('controller', 'pod-z', 'owns'),
        relation('pod-a', 'backend', 'calls'),
        relation('pod-z', 'backend', 'calls', older),
        relation('caller-service', 'pod-a', 'runs_on'),
        relation('caller-service', 'pod-z', 'runs_on'),
        relation('target-service', 'backend', 'runs_on'),
      ],
      coverage: [],
      conflicts: [],
    };
    if (reverse) graph.relations.reverse();
    const result = discoveredOperationalTopology(graph);
    for (const from of ['controller', 'caller-service'])
      expect(
        result.relations.find((edge) => edge.from === from && edge.kind === 'calls'),
      ).toMatchObject({ observedAt: at, attributes: { outcome: 'response_recorded' } });
    graph.relations = graph.relations.filter((relation) => relation.kind !== 'runs_on');
    expect(
      discoveredOperationalTopology(graph).relations.some(
        (edge) => edge.from === 'caller-service' && edge.kind === 'calls',
      ),
    ).toBe(false);
  },
);

test.each([false, true])(
  'newer attribute-free evidence retains its time regardless of input order: %s',
  (reverse) => {
    const latest = { ...relation('caller', 'target', 'calls'), attributes: undefined };
    const samples = [relation('caller', 'target', 'calls', older), latest];
    const graph: DiscoveredTopologyGraph = {
      entities: [node('caller'), node('target')],
      relations: reverse ? samples.reverse() : samples,
      coverage: [],
      conflicts: [],
    };
    const [edge] = discoveredOperationalTopology(graph).relations;
    expect(edge?.observedAt).toBe(at);
    expect(edge?.attributes).toBeUndefined();
  },
);

test.each(['stale', 'inferred', 'future', 'expired', 'ambiguous'] as const)(
  'service call projection rejects %s runtime bindings',
  (invalid) => {
    const binding = relation('caller-service', 'caller', 'runs_on');
    if (invalid === 'stale') binding.stale = true;
    if (invalid === 'inferred') binding.evidence = 'inferred';
    if (invalid === 'future')
      binding.sources = [{ ...source(), validFrom: '2026-09-13T00:06:00.000Z' }];
    if (invalid === 'expired') binding.sources = [source(older)];
    const graph: DiscoveredTopologyGraph = {
      entities: [
        node('caller'),
        node('target'),
        node('caller-service', 'service'),
        node('target-service', 'service'),
        node('other-service', 'service'),
      ],
      relations: [
        relation('caller', 'target', 'calls'),
        binding,
        relation('target-service', 'target', 'runs_on'),
        ...(invalid === 'ambiguous' ? [relation('other-service', 'caller', 'runs_on')] : []),
      ],
      coverage: [],
      conflicts: [],
    };
    expect(
      discoveredOperationalTopology(graph)
        .relations.filter((edge) => edge.kind === 'calls')
        .map((edge) => edge.from),
    ).toEqual(['caller']);
  },
);
