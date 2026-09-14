import type { DiscoveredTopologyGraph, TopologyRef } from '@sre/contracts';

/** Resolve log locators only inside an observed inventory binding's validity interval.
 * @param ref - Provider-normalized cluster and endpoint locator.
 * @param at - Log event time, not collection time.
 * @param entities - Tenant-scoped inventory candidates.
 */
export function resolveTrafficReference(
  ref: TopologyRef,
  at: string,
  entities: DiscoveredTopologyGraph['entities'],
): string | null {
  const cluster = ref.authority.replace(/^kubernetes-traffic:/, 'kubernetes-cluster:');
  let identity: unknown;
  try {
    identity = JSON.parse(ref.id);
  } catch {
    return null;
  }
  const time = Date.parse(at);
  if (!Array.isArray(identity) || !Number.isFinite(time)) return null;
  const candidates = entities.filter((entity) => {
    if (
      entity.scope.cluster !== cluster ||
      !entity.sources.some(
        (source) =>
          source.completeness !== 'unavailable' &&
          source.validFrom &&
          Date.parse(source.validFrom) <= time &&
          time <= Date.parse(source.observedAt),
      )
    )
      return false;
    if (ref.kind === 'pod_name')
      return (
        identity.length === 2 &&
        entity.ref.kind === 'Pod' &&
        entity.scope.namespace === identity[0] &&
        entity.name === identity[1]
      );
    if (ref.kind === 'pod_address')
      return (
        identity.length === 1 &&
        entity.ref.kind === 'Pod' &&
        entity.network?.addresses.includes(identity[0] as string)
      );
    if (ref.kind === 'tcp_address')
      return (
        (entity.ref.kind === 'Pod' || entity.ref.kind === 'Service') &&
        identity.length === 2 &&
        entity.network?.addresses.includes(identity[0] as string) &&
        entity.network.ports.includes(identity[1] as number)
      );
    return false;
  });
  const keys = new Set(candidates.map((entity) => entity.key));
  return keys.size === 1 ? [...keys][0]! : null;
}
