import type { NormalizedSnapshot } from '@sre/connectors';

/** Preserve collection evidence before resource snapshots are flattened. */
export function topologyCoverage(
  source: {
    id: string;
    name: string;
    pollSucceededAt?: Date | null;
    pollFailureCategory?: string | null;
  },
  snapshots: NormalizedSnapshot[],
) {
  const marker = snapshots.find(
    (snapshot) => snapshot.metadata.kind === 'collection' && snapshot.metadata.resource === 'pods',
  );
  const timestamp = marker ? new Date(marker.observedAt).getTime() : NaN;
  const completeness = marker?.metadata.completeness;
  const state = source.pollFailureCategory
    ? 'unavailable'
    : snapshots.length === 0
      ? 'unavailable'
      : !Number.isFinite(timestamp) || !['complete', 'partial'].includes(String(completeness))
        ? 'unknown'
        : completeness === 'partial'
          ? 'partial'
          : 'complete';
  return {
    dataSourceId: source.id,
    dataSourceName: source.name,
    state,
    observedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    lastSucceededAt: source.pollSucceededAt?.toISOString() ?? null,
  };
}
