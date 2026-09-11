import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import type { IDataSourceConnector } from '../../types';

const AWS_CONNECTOR = {
  type: 'aws',
  capabilities: {
    availability: 'incomplete',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'none',
    polling: 'none',
    events: 'none',
  },
} as const;

// AWS CloudWatch alarms reach triage via the Slack inbound path (Edition-1), not a direct webhook.
// Pull tools land in a future issue; until then this is an inert registered stub.
/**
 * Creates the explicitly incomplete AWS adapter without fabricating evidence.
 *
 * @param config - Tenant-scoped connector identity and settings.
 */
export function makeAwsConnector(config: ConnectorConfig): IDataSourceConnector {
  return createDataSourceConnector(config, AWS_CONNECTOR, {
    async probe() {
      return {
        status: 'not_applicable',
        reachable: false,
        authorized: false,
        warnings: ['aws has no outbound connection to test'],
      };
    },
  });
}

export const awsConnectorDefinition = defineConnector({
  ...AWS_CONNECTOR,
  create: makeAwsConnector,
});
