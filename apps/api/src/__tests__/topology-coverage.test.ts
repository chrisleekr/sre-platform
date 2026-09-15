import { describe, expect, test } from 'vitest';
import type { NormalizedSnapshot } from '@sre/connectors';
import { topologyCoverage } from '../topology-coverage';
import { toInfraSnapshot } from '../snapshots';

const source = { id: 'source', name: 'Cluster' };
const snapshot = (metadata: Record<string, unknown>): NormalizedSnapshot => ({
  tenantId: 'tenant',
  source: 'kubernetes',
  entityId: 'collection/pods',
  metrics: {},
  metadata,
  observedAt: new Date('2026-09-12T00:00:00Z'),
});

describe('topology collection evidence', () => {
  test('malformed pod timestamps are omitted instead of becoming fresh', () => {
    expect(toInfraSnapshot({ ...snapshot({ kind: 'pod' }), observedAt: new Date(NaN) })).toBeNull();
  });
  test('an empty cache is unavailable, not a complete empty inventory', () => {
    expect(topologyCoverage(source, []).state).toBe('unavailable');
    expect(
      topologyCoverage(source, [
        snapshot({ kind: 'collection', resource: 'pods', completeness: 'complete' }),
      ]).state,
    ).toBe('complete');
  });
  test('preserves partial collection and unknown legacy coverage', () => {
    expect(
      topologyCoverage(source, [
        snapshot({ kind: 'collection', resource: 'pods', completeness: 'partial' }),
      ]).state,
    ).toBe('partial');
    expect(topologyCoverage(source, [snapshot({ kind: 'pod' })]).state).toBe('unknown');
  });
  test('a failed latest poll does not make last-good cached evidence current', () => {
    expect(
      topologyCoverage({ ...source, pollFailureCategory: 'forbidden' }, [
        snapshot({ kind: 'collection', resource: 'pods', completeness: 'complete' }),
      ]).state,
    ).toBe('unavailable');
  });
});
