import { expect, test } from 'vitest';
import { topologyEndpoint, deduplicateTopology } from '../topology-projection';
import type { TopologyCollection, TopologyEntity, TopologyRelation } from '@sre/contracts';

const entity = (evidenceAt?: string): TopologyEntity => ({
  ref: { authority: 'provider', kind: 'service', id: 'one' },
  kind: 'service',
  name: 'one',
  scope: {},
  attributes: {},
  evidenceAt,
});
const relation = (evidenceAt?: string): TopologyRelation => ({
  from: entity().ref,
  to: { ...entity().ref, id: 'two' },
  kind: 'calls',
  evidence: 'observed',
  description: '',
  evidenceAt,
});
test.each([false, true])(
  'deduplication compares timestamp instants for both fact types: %s',
  (reverse) => {
    const older = '2026-09-15T01:00:00+02:00',
      newer = '2026-09-15T00:30:00Z';
    const times = reverse ? [newer, older] : [older, newer];
    const collection: TopologyCollection = {
      key: 'inventory',
      completeness: 'complete',
      entities: times.map(entity),
      relations: times.map(relation),
    };
    const result = deduplicateTopology(collection);
    expect(result.entities.map((value) => value.evidenceAt)).toEqual([newer]);
    expect(result.relations.map((value) => value.evidenceAt)).toEqual([newer]);
  },
);
test('equal absent or invalid evidence times keep the last input deterministically', () => {
  const lastEntity = { ...entity('invalid'), name: 'last' },
    lastRelation = { ...relation('invalid'), description: 'last' };
  const result = deduplicateTopology({
    key: 'inventory',
    completeness: 'complete',
    entities: [entity(), lastEntity],
    relations: [relation(), lastRelation],
  });
  expect(result.entities).toEqual([lastEntity]);
  expect(result.relations).toEqual([lastRelation]);
});
test('endpoint projection rejects recognized credentials including encoded path tokens', () => {
  const token = `ghp_${'A'.repeat(36)}`;
  for (const path of [
    `/reset/${token}`,
    `/access/${token.replace('ghp_', '%67%68%70%5f')}`,
    '/token%3Dprivate-value',
  ])
    expect(topologyEndpoint(`https://service.example${path}`)).toBeNull();
  expect(topologyEndpoint('https://service.example/status')).toMatchObject({
    ref: { id: 'https://service.example/status' },
    attributes: { url: 'https://service.example/status' },
  });
});
