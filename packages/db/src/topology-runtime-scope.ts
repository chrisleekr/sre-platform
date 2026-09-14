import type { ObservedTopologyFact, TopologyEntity, TopologyRuntimeScope } from '@sre/contracts';

/** Admit only recently observed namespaces from current-generation Kubernetes inventory.
 * @param rows - Tenant-scoped, enabled connector inventories.
 */
export function runtimeScopesFromInventory(
  rows: Array<{
    sourceType: string;
    collection: { completeness: string; entities: ObservedTopologyFact<TopologyEntity>[] };
  }>,
): TopologyRuntimeScope[] {
  const scopes = rows
    .filter(
      (row) => row.sourceType === 'kubernetes' && row.collection.completeness !== 'unavailable',
    )
    .flatMap((row) => row.collection.entities)
    .filter((fact) => !fact.retired && Date.now() - Date.parse(fact.observedAt) <= 600_000)
    .flatMap((fact) => {
      const { cluster, namespace } = fact.value.scope;
      return cluster && /^kubernetes-cluster:[0-9a-f-]{36}$/i.test(cluster) && namespace
        ? [{ clusterId: cluster.slice('kubernetes-cluster:'.length), namespace }]
        : [];
    });
  return [...new Map(scopes.map((scope) => [JSON.stringify(scope), scope])).values()];
}
