import { createDataSourceConnector, defineConnector, type ConnectorConfig } from '../../registry';
import { dataSourceEntityCoverage } from '../../entity-coverage';
import { dnsLookup, type HostLookup } from '../../ssrf';
import type { IDataSourceConnector, ProbeResult, TriageContext } from '../../types';
import {
  TRIAGE_ALERT_CAP,
  buildGetUrl,
  connect,
  gInit,
  gget,
  mapAlert,
  referencesService,
  type FetchLike,
  type GrafanaClient,
  type GrafanaConnectorOptions,
} from './client';
import { makeGrafanaTools } from './tools';
import { grafanaTopology } from './topology';

const GRAFANA_CONNECTOR = {
  type: 'grafana',
  capabilities: {
    topology: 'inventory',
    availability: 'ready',
    configuration: 'tenant',
    instances: 'multiple',
    investigation: 'tools',
    polling: 'none',
    events: 'none',
  },
} as const;

/**
 * Creates a Grafana adapter with bounded dashboard, alert, annotation, and query reads.
 *
 * @remarks Raw metrics remain owned by metric connectors; this adapter never proxies data sources.
 * @param config - Tenant-scoped Grafana settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Grafana API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 * @param options - Exact supervised loopback origins allowed during development.
 */
export function makeGrafanaConnector(
  config: ConnectorConfig,
  fetchImpl: FetchLike = fetch,
  lookup: HostLookup = dnsLookup,
  options: GrafanaConnectorOptions = {},
): IDataSourceConnector {
  return createDataSourceConnector(config, GRAFANA_CONNECTOR, {
    topology: grafanaTopology(config, fetchImpl, lookup, options),
    entityCoverage: dataSourceEntityCoverage(
      config.id,
      ['alert_context'],
      ['service', 'workload', 'namespace', 'node', 'cluster', 'endpoint', 'database', 'host'],
    ),
    async fetchTriageContext(query): Promise<TriageContext> {
      // Down-first: pull the actively-firing Grafana Alertmanager alerts, best-effort scope to the
      // service, and fall back to all-firing when nothing matches (Grafana has no universal service key,
      // so "what is firing right now" is a real opener even unfiltered — the Prometheus alerts precedent).
      // windowMinutes is inert (firing state is current, not windowed) but echoed for transparency.
      try {
        const c = await connect(config, lookup, options);
        const data = await gget(fetchImpl, c, '/api/alertmanager/grafana/api/v2/alerts', {
          active: true,
        });
        const firing = (Array.isArray(data) ? data : [])
          .map(mapAlert)
          .filter((a) => a.state === 'active' || a.state === undefined);
        const scoped = firing.filter((a) => referencesService(a, query.service));
        const firingAlerts = (scoped.length > 0 ? scoped : firing).slice(0, TRIAGE_ALERT_CAP);
        return {
          source: 'grafana',
          data: { service: query.service, windowMinutes: query.windowMinutes, firingAlerts },
        };
      } catch {
        return {
          source: 'grafana',
          data: {
            service: query.service,
            windowMinutes: query.windowMinutes,
            note: 'grafana first-pass unavailable (credential or reachability)',
          },
        };
      }
    },
    tools: () => makeGrafanaTools(config, fetchImpl, lookup, options),
    async probe(): Promise<ProbeResult> {
      let client: GrafanaClient;
      try {
        client = await connect(config, lookup, options);
      } catch (e) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: [e instanceof Error ? e.message : 'grafana connector: configuration error'],
        };
      }
      // GET /api/org proves reachability + the token at least privilege: every service account belongs
      // to an org, so it needs no dashboard/datasource read scope (verified against Grafana 12.3.1 with a
      // Viewer service-account token). /api/health is unauthenticated and would not prove the credential.
      let statusCode: number | null;
      try {
        const res = await fetchImpl(buildGetUrl(client.base, '/api/org'), {
          ...gInit(client),
          // Inspect, but never follow, an authentication-gateway redirect. Following could send the
          // bearer token elsewhere; treating the blocked redirect as a network error is also false.
          redirect: 'manual',
        });
        statusCode = res.status;
      } catch {
        statusCode = null;
      }
      if (statusCode === null) {
        return {
          status: 'unhealthy',
          reachable: false,
          authorized: false,
          warnings: ['grafana did not respond'],
        };
      }
      if (statusCode === 200) {
        return { status: 'healthy', reachable: true, authorized: true, warnings: [] };
      }
      if (statusCode === 401 || statusCode === 403) {
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings: ['grafana reachable but the credential was rejected'],
        };
      }
      if (statusCode >= 300 && statusCode < 400) {
        return {
          status: 'unhealthy',
          reachable: true,
          authorized: false,
          warnings: ['grafana redirected the API request to an authentication gateway'],
          failureCategory: 'permission_denied',
        };
      }
      return {
        status: 'unhealthy',
        reachable: true,
        authorized: false,
        warnings: [`grafana returned ${statusCode}`],
      };
    },
  });
}

export const grafanaConnectorDefinition = defineConnector({
  ...GRAFANA_CONNECTOR,
  create: makeGrafanaConnector,
});
