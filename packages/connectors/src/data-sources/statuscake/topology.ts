import type { TopologyCollection, TopologyReader } from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import { obj, str } from '../../values';
import { deduplicateTopology, topologyEndpoint } from '../../topology-projection';
import { topologyReadIssue } from '../../topology-transport';
import { finishTopologyPage, shouldReadTopologyCollection } from '../../topology-scan';

/** Discover monitor-to-endpoint relationships without retaining heartbeat secrets or contact data.
 * @param config - Tenant-owned StatusCake account connection.
 * @param createRead - Create a host-pinned GET transport with a fresh collection budget.
 */
export function statuscakeTopology(
  config: ConnectorConfig,
  createRead: () => (path: string, query: Record<string, number>) => Promise<unknown>,
): TopologyReader {
  return {
    async discover(options) {
      const read = createRead();
      const observedAt = new Date().toISOString();
      const collections: TopologyCollection[] = [];
      for (const kind of ['uptime', 'ssl', 'pagespeed', 'heartbeat']) {
        if (!shouldReadTopologyCollection(options, kind)) continue;
        const previous = options?.scans?.[kind];
        const firstPage = previous?.cursor ? Number(previous.cursor) : 1;
        if (!Number.isSafeInteger(firstPage) || firstPage < 1)
          throw new Error('Invalid monitor scan page');
        let nextPage: string | null = String(firstPage);
        const collection: TopologyCollection = {
          key: kind,
          completeness: 'complete',
          entities: [],
          relations: [],
        };
        try {
          for (let page = firstPage; page < firstPage + 5; page += 1) {
            const response = obj(await read(`/v1/${kind}`, { page, per_page: 100 }));
            if (!Array.isArray(response.data)) {
              collection.completeness = 'partial';
              collection.issue = 'invalid_response';
              break;
            }
            for (const raw of response.data.slice(0, 100)) {
              const monitor = obj(raw),
                id =
                  str(monitor.id) ??
                  (typeof monitor.id === 'number' ? String(monitor.id) : undefined);
              if (!id) {
                collection.completeness = 'partial';
                collection.issue = 'invalid_response';
                continue;
              }
              const ref = { authority: `connector:${config.id}`, kind, id };
              const attributes: Record<string, string> = { resourceKind: `${kind} monitor` };
              if (str(monitor.status)) attributes.status = str(monitor.status)!;
              if (typeof monitor.paused === 'boolean') attributes.paused = String(monitor.paused);
              collection.entities.push({
                ref,
                kind: 'monitor',
                name: str(monitor.name) ?? `${kind} ${id}`,
                scope: {},
                attributes,
              });
              // Heartbeat URLs are write credentials, not the application's public endpoint.
              const endpoint = kind === 'heartbeat' ? null : topologyEndpoint(monitor.website_url);
              if (endpoint) {
                collection.entities.push(endpoint);
                collection.relations.push({
                  from: ref,
                  to: endpoint.ref,
                  kind: 'monitors',
                  evidence: 'provider_reference',
                  description: `StatusCake ${kind} monitor configuration`,
                });
              }
            }
            const pages = obj(response.metadata).page_count;
            if (page === 1 && pages === 0 && response.data.length === 0) {
              nextPage = null;
              break;
            }
            if (
              !Number.isSafeInteger(pages) ||
              Number(pages) < page ||
              response.data.length > 100
            ) {
              collection.completeness = 'partial';
              collection.issue = 'invalid_response';
              break;
            }
            nextPage = page >= Number(pages) ? null : String(page + 1);
            if (!nextPage) break;
          }
        } catch (error) {
          const status = (error as { status?: number } | null)?.status;
          collection.completeness = collection.entities.length ? 'partial' : 'unavailable';
          collection.issue =
            topologyReadIssue(error) ??
            (status === 401 || status === 403
              ? 'permission_denied'
              : status === 429
                ? 'rate_limited'
                : 'unreachable');
        }
        collections.push(finishTopologyPage(deduplicateTopology(collection), nextPage, previous));
      }
      return { observedAt, collections };
    },
  };
}
