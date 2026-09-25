import type { ConnectorMetadata } from '../../registry';

/** Reserved product capability. No runtime factory is shipped until read-only tools exist. */
export const confluenceConnectorMetadata = {
  type: 'confluence',
  capabilities: {
    alertLifecycle: 'none',
    availability: 'incomplete',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'none',
    polling: 'none',
    events: 'none',
  },
} as const satisfies ConnectorMetadata<'confluence'>;
