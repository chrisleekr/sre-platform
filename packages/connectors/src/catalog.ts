import { argoCdConnectorDefinition } from './data-sources/argocd';
import { awsConnectorDefinition } from './data-sources/aws';
import { confluenceConnectorMetadata } from './data-sources/confluence';
import { datadogConnectorDefinition } from './data-sources/datadog';
import { githubConnectorDefinition } from './data-sources/github';
import { gitlabConnectorDefinition } from './data-sources/gitlab';
import { grafanaConnectorDefinition } from './data-sources/grafana';
import { kubernetesConnectorDefinition } from './data-sources/kubernetes';
import { networkProbeConnectorDefinition } from './data-sources/networkprobe';
import { prometheusConnectorDefinition } from './data-sources/prometheus';
import { statusCakeConnectorDefinition } from './data-sources/statuscake';
import type { ConnectorDefinition, ConnectorMetadata } from './registry';
import { CONNECTOR_TYPE_IDS, type ConnectorCapabilities, type ConnectorType } from './types';

/** Product catalog. A type appears exactly once, beside its capabilities and optional factory. */
export const CONNECTOR_DEFINITIONS = [
  datadogConnectorDefinition,
  prometheusConnectorDefinition,
  githubConnectorDefinition,
  gitlabConnectorDefinition,
  confluenceConnectorMetadata,
  awsConnectorDefinition,
  kubernetesConnectorDefinition,
  argoCdConnectorDefinition,
  statusCakeConnectorDefinition,
  grafanaConnectorDefinition,
  networkProbeConnectorDefinition,
] as const satisfies readonly ConnectorMetadata[];

const byType = new Map(CONNECTOR_DEFINITIONS.map((definition) => [definition.type, definition]));
if (
  byType.size !== CONNECTOR_TYPE_IDS.length ||
  CONNECTOR_TYPE_IDS.some((type) => !byType.has(type))
) {
  throw new Error('connector catalog must define every connector type exactly once');
}

export const CONNECTOR_TYPES: readonly ConnectorType[] = CONNECTOR_TYPE_IDS;

export const CONNECTOR_CAPABILITIES = Object.freeze(
  Object.fromEntries(
    CONNECTOR_DEFINITIONS.map((definition) => [definition.type, definition.capabilities]),
  ) as Record<ConnectorType, ConnectorCapabilities>,
);

/**
 * Returns the declared capability contract for a connector type.
 *
 * @param type - Connector type registered in the compile-time catalog.
 */
export function connectorCapabilities(type: ConnectorType): ConnectorCapabilities {
  return CONNECTOR_CAPABILITIES[type];
}

/**
 * Checks whether an untrusted string names a registered connector type.
 *
 * @param value - Candidate connector type identifier.
 */
export function isConnectorType(value: string): value is ConnectorType {
  return byType.has(value as ConnectorType);
}

function isRuntimeDefinition(definition: ConnectorMetadata): definition is ConnectorDefinition {
  return 'create' in definition && typeof definition.create === 'function';
}

/**
 * Returns catalog entries that provide executable connector factories.
 */
export function runtimeConnectorDefinitions(): ConnectorDefinition[] {
  const definitions: ConnectorDefinition[] = [];
  for (const definition of CONNECTOR_DEFINITIONS) {
    if (isRuntimeDefinition(definition)) definitions.push(definition);
  }
  return definitions;
}
