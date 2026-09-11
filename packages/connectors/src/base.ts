import { connectorCapabilities } from './catalog';
import { createDataSourceConnector, type ConnectorConfig } from './registry';
import type { ConnectorType, IDataSourceConnector } from './types';

/**
 * Creates an inert adapter for a declared but unimplemented connector type.
 *
 * @param type - Connector type whose capability contract remains visible.
 * @param identity - Stable connector identifier and display name.
 */
export function stubConnector(
  type: ConnectorType,
  identity: Pick<IDataSourceConnector, 'id' | 'name'>,
): IDataSourceConnector {
  const config: ConnectorConfig = {
    ...identity,
    type,
    tenantId: '',
    settings: {},
    getCredential: async () => '',
  };
  return createDataSourceConnector(
    config,
    { type, capabilities: connectorCapabilities(type) },
    {
      async probe() {
        return {
          status: 'not_applicable' as const,
          reachable: false,
          authorized: false,
          warnings: [`${type} has no outbound connection to test`],
        };
      },
    },
  );
}
