import type { TopologyCollection, TopologyReader } from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import { topologyFetch, topologyReadIssue } from '../../topology-transport';
import { finishTopologyPage, shouldReadTopologyCollection } from '../../topology-scan';
import type { HostLookup } from '../../ssrf';
import { obj, str } from '../../values';
import { deduplicateTopology, topologyEndpoint } from '../../topology-projection';
import { connect, gget, validateUid, type FetchLike, type GrafanaConnectorOptions } from './client';

function readIssue(error: unknown): TopologyCollection['issue'] {
  const status = (error as { status?: number } | null)?.status;
  const known = topologyReadIssue(error);
  if (known) return known;
  if (status === 401 || status === 403) return 'permission_denied';
  // A 429 must read as rate_limited: that is the only issue that pauses continuations and sets the
  // connector cooldown, so reporting it as unreachable kept the scan pressing a throttling Grafana.
  if (status === 429) return 'rate_limited';
  return 'unreachable';
}

/** Read dashboard references to configured backends without proxying queries or claiming trace access.
 * @param config - Tenant-owned Grafana connection and credential scope.
 * @param fetchImpl - Existing guarded Grafana transport.
 * @param lookup - Resolver for the Grafana SSRF guard.
 * @param options - Explicit development-loopback allowances.
 */
export function grafanaTopology(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  options: GrafanaConnectorOptions,
): TopologyReader {
  return {
    async discover(discovery) {
      const observedAt = new Date().toISOString();
      const transport = topologyFetch(fetchImpl);
      const client = await connect(config, lookup, options);
      const authority = `connector:${config.id}`;
      const collections: TopologyCollection[] = [];
      if (shouldReadTopologyCollection(discovery, 'datasources')) {
        const backends: TopologyCollection = {
          key: 'datasources',
          completeness: 'complete',
          entities: [],
          relations: [],
        };
        const backendScan = discovery?.scans?.datasources;
        const backendOffset = backendScan?.cursor ? Number(backendScan.cursor) : 0;
        if (!Number.isSafeInteger(backendOffset) || backendOffset < 0)
          throw new Error('Invalid datasource scan offset');
        let nextBackend: string | null = String(backendOffset);
        try {
          const response = await gget(transport, client, '/api/datasources');
          if (!Array.isArray(response)) throw new Error('Invalid Grafana datasource response');
          response.sort((a, b) => String(obj(a).uid ?? '').localeCompare(String(obj(b).uid ?? '')));
          nextBackend =
            backendOffset + 1000 < response.length ? String(backendOffset + 1000) : null;
          for (const raw of response.slice(backendOffset, backendOffset + 1000)) {
            const source = obj(raw),
              uid = str(source.uid);
            if (!uid) {
              backends.completeness = 'partial';
              backends.issue = 'invalid_response';
              continue;
            }
            const ref = { authority, kind: 'datasource', id: uid };
            backends.entities.push({
              ref,
              kind: 'connector',
              name: str(source.name) ?? uid,
              scope: {},
              attributes: {
                resourceKind: 'Grafana datasource',
                type: str(source.type) ?? 'unknown',
              },
            });
            const endpoint = topologyEndpoint(source.url);
            if (endpoint) {
              backends.entities.push(endpoint);
              backends.relations.push({
                from: ref,
                to: endpoint.ref,
                kind: 'reads_from',
                evidence: 'declared',
                description: 'Grafana datasource configuration; backend access is not verified',
              });
            }
          }
        } catch (error) {
          backends.completeness = 'unavailable';
          backends.issue = readIssue(error);
        }
        collections.push(
          finishTopologyPage(deduplicateTopology(backends), nextBackend, backendScan),
        );
      }
      if (shouldReadTopologyCollection(discovery, 'dashboards')) {
        const dashboards: TopologyCollection = {
          key: 'dashboards',
          completeness: 'complete',
          entities: [],
          relations: [],
        };
        const previous = discovery?.scans?.dashboards;
        const page = previous?.cursor ? Number(previous.cursor) : 1;
        if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid dashboard scan page');
        let nextPage: string | null = String(page);
        try {
          const response = await gget(transport, client, '/api/search', {
            type: 'dash-db',
            limit: 25,
            page,
          });
          if (!Array.isArray(response)) throw new Error('Invalid Grafana dashboard response');
          nextPage = response.length >= 25 ? String(page + 1) : null;
          if (response.length > 25) {
            dashboards.completeness = 'partial';
            dashboards.issue = 'limit';
          }
          for (const raw of response.slice(0, 25)) {
            const dashboard = obj(raw),
              uid = str(dashboard.uid);
            if (!uid) {
              dashboards.completeness = 'partial';
              dashboards.issue = 'invalid_response';
              continue;
            }
            const ref = { authority, kind: 'dashboard', id: uid };
            dashboards.entities.push({
              ref,
              kind: 'dashboard',
              name: str(dashboard.title) ?? uid,
              scope: {},
              attributes: { resourceKind: 'Grafana dashboard' },
            });
            try {
              const model = obj(
                obj(await gget(transport, client, `/api/dashboards/uid/${validateUid('uid', uid)}`))
                  .dashboard,
              );
              if (!Array.isArray(model.panels)) {
                dashboards.completeness = 'partial';
                dashboards.issue = 'invalid_response';
                continue;
              }
              const pending = [...model.panels];
              let visited = 0;
              while (pending.length && visited++ < 200) {
                const panel = obj(pending.shift());
                if (Array.isArray(panel.panels)) pending.push(...panel.panels.slice(0, 200));
                const references = [
                  panel.datasource,
                  ...(Array.isArray(panel.targets)
                    ? panel.targets.map((target) => obj(target).datasource)
                    : []),
                ];
                for (const candidate of references) {
                  const datasourceUid = str(obj(candidate).uid);
                  if (
                    datasourceUid &&
                    !datasourceUid.startsWith('$') &&
                    datasourceUid !== '-- Mixed --'
                  )
                    dashboards.relations.push({
                      from: ref,
                      to: { authority, kind: 'datasource', id: datasourceUid },
                      kind: 'reads_from',
                      evidence: 'declared',
                      description: 'Dashboard panel datasource UID',
                    });
                }
              }
              if (pending.length) {
                dashboards.completeness = 'partial';
                dashboards.issue = 'limit';
              }
            } catch (error) {
              dashboards.completeness = 'partial';
              dashboards.issue = readIssue(error);
              if (dashboards.issue === 'rate_limited') {
                // Stop reading and keep this page so the pass after the cooldown re-reads it.
                nextPage = String(page);
                break;
              }
            }
          }
        } catch (error) {
          dashboards.completeness = 'unavailable';
          dashboards.issue = readIssue(error);
        }
        collections.push(finishTopologyPage(deduplicateTopology(dashboards), nextPage, previous));
      }
      return { observedAt, collections };
    },
  };
}
