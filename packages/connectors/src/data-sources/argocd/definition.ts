import type { ConnectorMetadata } from '../../registry';

export const ARGOCD_CONNECTOR_METADATA = {
  type: 'argocd',
  capabilities: {
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'snapshots',
    events: 'none',
  },
} as const satisfies ConnectorMetadata<'argocd'>;
