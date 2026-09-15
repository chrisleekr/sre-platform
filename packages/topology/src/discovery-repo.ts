import { connectorConfigs, withTenant, listTopologyDiscovery, type Db } from '@sre/db';
import { isNull } from 'drizzle-orm';
import { CONNECTOR_TYPES, connectorCapabilities } from '@sre/connectors';
import type { DiscoveredTopologyGraph } from '@sre/contracts';
import { resolveDiscoveredTopology } from './discovery';
import { discoveredOperationalTopology } from './operational';

/** Read one shared resolved topology for dashboard, incident and investigation consumers.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning every contributing connector.
 */
export async function readDiscoveredTopology(db: Db, tenantId: string) {
  const discovery = await listTopologyDiscovery(db, tenantId);
  const graph = resolveDiscoveredTopology(
    discovery.map(({ collection, sourceName, sourceType }) => ({
      ...collection,
      connectorName: sourceName,
      connectorType: sourceType,
      observedAt: collection.observedAt.toISOString(),
      attemptedAt: collection.attemptedAt.toISOString(),
    })),
  );
  const sources = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: connectorConfigs.id,
        name: connectorConfigs.name,
        type: connectorConfigs.type,
        enabled: connectorConfigs.enabled,
      })
      .from(connectorConfigs)
      .where(isNull(connectorConfigs.deletedAt)),
  );
  const capabilities: NonNullable<DiscoveredTopologyGraph['capabilities']> =
    CONNECTOR_TYPES.flatMap((type): NonNullable<DiscoveredTopologyGraph['capabilities']> => {
      const metadata = connectorCapabilities(type);
      const mode =
        metadata.availability === 'incomplete'
          ? 'unsupported'
          : (metadata.topology ?? 'unsupported');
      const configured = sources.filter((source) => source.type === type);
      if (!configured.length)
        return [
          {
            connectorId: null,
            name: type,
            type,
            mode,
            state:
              mode === 'unsupported'
                ? 'unsupported'
                : metadata.configuration === 'builtin'
                  ? 'on_demand'
                  : 'not_connected',
          },
        ];
      return configured.map((source) => ({
        connectorId: source.id,
        name: source.name,
        type,
        mode,
        state:
          mode === 'unsupported'
            ? 'unsupported'
            : !source.enabled
              ? 'disabled'
              : mode === 'on_demand'
                ? 'on_demand'
                : graph.coverage.some((collection) => collection.connectorId === source.id)
                  ? 'collected'
                  : 'pending',
      }));
    });
  return { ...graph, capabilities, operational: discoveredOperationalTopology(graph) };
}
