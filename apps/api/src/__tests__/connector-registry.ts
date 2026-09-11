import {
  connectorCapabilities,
  defineConnector,
  type ConnectorFactory,
  type ConnectorRegistry,
  type ConnectorType,
} from '@sre/connectors';

/** Register a focused test factory without bypassing the production definition contract. */
export function registerTestConnector(
  registry: ConnectorRegistry,
  type: ConnectorType,
  create: ConnectorFactory,
): void {
  registry.register(defineConnector({ type, capabilities: connectorCapabilities(type), create }));
}
