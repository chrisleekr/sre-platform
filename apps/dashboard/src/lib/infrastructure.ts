import { INFRA_STALE_AFTER_MS, type InfraSnapshot } from './types';

export type InfraHealth = 'error' | 'stale' | 'attention' | 'healthy';

/** One operational classification shared by the Infrastructure and Topology views. */
export function infrastructureHealth(snapshot: InfraSnapshot, now: number): InfraHealth {
  if (snapshot.error) return 'error';
  const observedAt = Date.parse(snapshot.observedAt);
  if (Number.isNaN(observedAt) || now - observedAt > INFRA_STALE_AFTER_MS) return 'stale';

  const ready = snapshot.metrics.ready;
  const oomKilled = snapshot.metrics.oomKilled ?? 0;
  const pressureCount = snapshot.metrics.pressures ?? snapshot.pressures?.length ?? 0;

  if (snapshot.kind === 'pod') {
    if (snapshot.phase === 'Succeeded') return oomKilled > 0 ? 'attention' : 'healthy';
    if (oomKilled > 0) return 'attention';
    if (snapshot.phase && snapshot.phase !== 'Running') return 'attention';
    if (ready !== undefined && ready !== 1) return 'attention';
    if (snapshot.containers?.some((container) => container.waitingReason)) return 'attention';
  }

  if (snapshot.kind === 'node' && (ready !== 1 || pressureCount > 0)) return 'attention';
  if (!snapshot.kind && (ready === 0 || oomKilled > 0)) return 'attention';
  return 'healthy';
}
