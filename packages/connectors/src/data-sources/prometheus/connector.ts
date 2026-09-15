import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dataSourceEntityCoverage } from '../../entity-coverage';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type { IDataSourceConnector, ProbeResult, TriageContext } from '../../types';
import { obj } from '../../values';
import {
  API_TIMEOUT_MS,
  TRIAGE_ALERT_CAP,
  buildGetUrl,
  connect,
  mapAlert,
  pget,
  referencesService,
  type FetchLike,
  type PromClient,
  type PrometheusConnectorOptions,
} from './client';
import { makePrometheusSli } from './sli';
import { makePrometheusTools } from './tools';
import { prometheusTopology } from './topology';

const PROMETHEUS_CONNECTOR = {
  type: 'prometheus',
  capabilities: {
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'authenticated',
  },
} as const;

/**
 * Creates a Prometheus adapter with bounded metric, alert, and Alertmanager reads.
 *
 * @remarks This on-demand adapter supports explicit auth strategies and private-network endpoints.
 * @param config - Tenant-scoped Prometheus settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Prometheus API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 * @param options - Exact supervised loopback origins allowed during development.
 */
export function makePrometheusConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
  options: PrometheusConnectorOptions = {},
): IDataSourceConnector {
  return createDataSourceConnector(config, PROMETHEUS_CONNECTOR, {
    topology: prometheusTopology(config, fetchImpl, lookup, options),
    entityCoverage: dataSourceEntityCoverage(
      config.id,
      ['metrics'],
      ['service', 'workload', 'namespace', 'node', 'cluster', 'endpoint', 'database', 'host'],
    ),
    async fetchTriageContext(query): Promise<TriageContext> {
      const c = await connect(config, lookup, options);
      const data = await pget(fetchImpl, c, '/api/v1/alerts');
      const raw = obj(obj(data).data).alerts;
      // /api/v1/alerts returns pending + firing; first-pass wants what is actually firing.
      const firing = (Array.isArray(raw) ? raw : [])
        .map(mapAlert)
        .filter((a) => a.state === 'firing');
      const scoped = firing.filter((a) => referencesService(a, query.service));
      // Prefer service-scoped alerts, but "what is firing" is useful first-pass context even unfiltered.
      const firingAlerts = (scoped.length > 0 ? scoped : firing).slice(0, TRIAGE_ALERT_CAP);
      return {
        source: 'prometheus',
        data: { service: query.service, windowMinutes: query.windowMinutes, firingAlerts },
      };
    },
    // The error-budget evaluator reads objectives through this capability. A tenant with two
    // Prometheus instances is resolved deterministically by connector id at the call site, because a
    // connector type alone cannot tell them apart.
    sli: makePrometheusSli(config, fetchImpl, lookup, options),
    tools: () => makePrometheusTools(config, fetchImpl, lookup, options),
    async probe(): Promise<ProbeResult> {
      const warnings: string[] = [];
      let client: PromClient;
      try {
        client = await connect(config, lookup, options);
      } catch (e) {
        warnings.push(e instanceof Error ? e.message : 'prometheus connector: configuration error');
        return { status: 'unhealthy', reachable: false, authorized: false, warnings };
      }
      // A trivial instant query proves reachability + the credential + that the query engine answers.
      let status: number | null;
      try {
        const init = await client.auth.apply({
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
          // Inspect, but never follow, a gateway redirect. Following could send the credential to a
          // different host; throwing would falsely report a reachable auth gateway as unreachable.
          redirect: 'manual',
          tls: client.serverTls,
        });
        const res = await fetchImpl(
          buildGetUrl(client.base, '/api/v1/query', { query: '1' }),
          init,
        );
        status = res.status;
      } catch {
        status = null;
      }
      if (status === null) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [...warnings, 'prometheus did not respond'],
        };
      }
      if (status === 200) {
        return { status: 'healthy', reachable: true, authorized: true, warnings };
      }
      if (status === 401 || status === 403) {
        warnings.push('prometheus reachable but the credential was rejected');
        return { status: 'unhealthy', reachable: true, authorized: false, warnings };
      }
      if (status >= 300 && status < 400) {
        warnings.push('prometheus redirected the API request to an authentication gateway');
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings,
          failureCategory: 'permission_denied',
        };
      }
      // No prior successful check to preserve health on, so an unconfirmable result is honestly unhealthy.
      warnings.push(`prometheus returned ${status}`);
      return { status: 'unhealthy', reachable: true, authorized: false, warnings };
    },
  });
}

export const prometheusConnectorDefinition = defineConnector({
  ...PROMETHEUS_CONNECTOR,
  create: makePrometheusConnector,
});
