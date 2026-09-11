import { connectorCapabilities } from './catalog';
import type { ConnectorConfig } from './registry';
import { createDataSourceConnector } from './registry';
import type { IDataSourceConnector } from './types';

/**
 * Creates the deterministic data-source adapter used by tests and contract examples.
 *
 * @param config - Connector identity and tenant context to preserve in fake results.
 */
export function makeFakeConnector(config: ConnectorConfig): IDataSourceConnector {
  const type = config.type;
  return createDataSourceConnector(
    config,
    { type, capabilities: connectorCapabilities(type) },
    {
      async snapshot() {
        return [
          {
            tenantId: config.tenantId,
            source: type,
            entityId: 'service-a',
            metrics: { cpu: 0.5 },
            metadata: {},
            observedAt: new Date(),
          },
        ];
      },
      async fetchTriageContext(query) {
        return {
          source: type,
          data: { service: query.service, windowMinutes: query.windowMinutes },
        };
      },
      tools: () => [],
      async probe() {
        return { status: 'healthy', reachable: true, authorized: true, warnings: [] };
      },
    },
  );
}
