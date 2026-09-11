import { runtimeConnectorDefinitions } from './catalog';
import { makeGrafanaConnector } from './data-sources/grafana';
import { makePrometheusConnector } from './data-sources/prometheus';
import { ConnectorRegistry, defineConnector } from './registry';
import { dnsLookup } from './ssrf';

export interface DefaultRegistryOptions {
  prometheusLoopbackOrigin?: string;
  grafanaLoopbackOrigin?: string;
}

function developmentPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`${key} must be an integer from 1 to 65535`);
  }
  return parsed;
}

/**
 * Derives exact loopback origins admitted only by the supervised development runtime.
 *
 * @param env - Environment variables controlling local observability tunnels.
 */
export function developmentRegistryOptions(env: NodeJS.ProcessEnv): DefaultRegistryOptions {
  if (
    env.NODE_ENV !== 'development' ||
    env.SRE_DEV_CONNECTOR_LOOPBACK !== 'true' ||
    env.DEV_OBSERVABILITY_TUNNELS === 'false'
  )
    return {};
  return {
    prometheusLoopbackOrigin: `http://127.0.0.1:${developmentPort(env, 'DEV_PROMETHEUS_LOCAL_PORT', 9090)}`,
    grafanaLoopbackOrigin: `http://127.0.0.1:${developmentPort(env, 'DEV_GRAFANA_LOCAL_PORT', 3000)}`,
  };
}

/**
 * Builds a registry containing every executable data-source adapter.
 *
 * @param options - Development-only loopback origins for supervised observability tunnels.
 */
export function defaultRegistry(options: DefaultRegistryOptions = {}): ConnectorRegistry {
  const definitions = runtimeConnectorDefinitions().map((definition) => {
    if (definition.type === 'prometheus') {
      return defineConnector({
        ...definition,
        create: (config) =>
          makePrometheusConnector(config, fetch, dnsLookup, {
            allowedLoopbackOrigins: options.prometheusLoopbackOrigin
              ? [options.prometheusLoopbackOrigin]
              : [],
          }),
      });
    }
    if (definition.type === 'grafana') {
      return defineConnector({
        ...definition,
        create: (config) =>
          makeGrafanaConnector(config, fetch, dnsLookup, {
            allowedLoopbackOrigins: options.grafanaLoopbackOrigin
              ? [options.grafanaLoopbackOrigin]
              : [],
          }),
      });
    }
    return definition;
  });
  return new ConnectorRegistry(definitions);
}
