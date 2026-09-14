import type { TopologyCollection, TopologyReader } from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import { topologyFetch } from '../../topology-transport';
import { finishTopologyPage, shouldReadTopologyCollection } from '../../topology-scan';
import type { HostLookup } from '../../ssrf';
import { obj, str } from '../../values';
import { deduplicateTopology, topologyEndpoint, topologyOpaqueId } from '../../topology-projection';
import { connect, pget, type FetchLike, type PrometheusConnectorOptions } from './client';

/** Discover scrape targets and explicit resource references without treating job labels as services.
 * @param config - Tenant-owned metrics backend and authentication settings.
 * @param fetchImpl - Existing guarded metrics transport.
 * @param lookup - Resolver for the metrics connector's SSRF guard.
 * @param options - Explicit development-loopback allowances.
 */
export function prometheusTopology(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  options: PrometheusConnectorOptions,
): TopologyReader {
  return {
    async discover(discovery) {
      const observedAt = new Date().toISOString();
      if (!shouldReadTopologyCollection(discovery, 'targets'))
        return { observedAt, collections: [] };
      const response = obj(
        await pget(
          topologyFetch(fetchImpl),
          await connect(config, lookup, options),
          '/api/v1/targets',
          {
            state: 'active',
          },
        ),
      );
      const targets = obj(response.data).activeTargets;
      if (response.status !== 'success' || !Array.isArray(targets))
        throw new Error('Invalid Prometheus targets response');
      targets.sort((a, b) =>
        JSON.stringify([obj(a).scrapePool, obj(a).scrapeUrl]).localeCompare(
          JSON.stringify([obj(b).scrapePool, obj(b).scrapeUrl]),
        ),
      );
      const previous = discovery?.scans?.targets;
      const offset = previous?.cursor ? Number(previous.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0)
        throw new Error('Invalid target scan offset');
      const collection: TopologyCollection = {
        key: 'targets',
        completeness: 'complete',
        entities: [],
        relations: [],
      };
      for (const raw of targets.slice(offset, offset + 1000)) {
        const target = obj(raw),
          labels = obj(target.labels),
          discovered = obj(target.discoveredLabels);
        const scrapeUrl = str(target.scrapeUrl),
          pool = str(target.scrapePool);
        if (!scrapeUrl || !pool) {
          collection.completeness = 'partial';
          collection.issue = 'invalid_response';
          continue;
        }
        const ref = {
          authority: `connector:${config.id}`,
          kind: 'scrape_target',
          id: topologyOpaqueId(pool, scrapeUrl),
        };
        const endpoint = topologyEndpoint(scrapeUrl);
        const attributes: Record<string, string> = {
          resourceKind: 'Scrape target',
          scrapePool: pool,
        };
        for (const key of [
          'job',
          'instance',
          'service',
          'service_name',
          'namespace',
          'pod',
          'cluster',
          'environment',
          'env',
        ]) {
          const value = str(labels[key]);
          if (value) attributes[key] = value;
        }
        // Health describes a scrape, never the application or the completeness of its call graph.
        if (['up', 'down', 'unknown'].includes(String(target.health)))
          attributes.scrapeHealth = String(target.health);
        const lastScrape = str(target.lastScrape);
        if (lastScrape && Number.isFinite(Date.parse(lastScrape)))
          attributes.lastScrape = new Date(lastScrape).toISOString();
        collection.entities.push({
          ref,
          kind: 'monitor',
          name: str(labels.job) ?? pool,
          scope: {},
          attributes,
        });
        if (endpoint) {
          collection.entities.push(endpoint);
          collection.relations.push({
            from: ref,
            to: endpoint.ref,
            kind: 'monitors',
            evidence: 'provider_reference',
            description: 'Prometheus active scrape target',
          });
        }
        const uid = str(discovered.__meta_kubernetes_pod_uid),
          namespace = str(discovered.__meta_kubernetes_namespace);
        if (uid && namespace)
          collection.relations.push({
            from: ref,
            to: {
              authority: 'kubernetes-object',
              kind: 'Pod',
              id: JSON.stringify([namespace, uid]),
            },
            kind: 'monitors',
            evidence: 'provider_reference',
            description:
              'Kubernetes discovery metadata identifies the target pod UID and namespace',
          });
      }
      return {
        observedAt,
        collections: [
          finishTopologyPage(
            deduplicateTopology(collection),
            offset + 1000 < targets.length ? String(offset + 1000) : null,
            previous,
          ),
        ],
      };
    },
  };
}
