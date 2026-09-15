import type { TopologyCollection, TopologyEntity, TopologyReader } from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import { obj, str } from '../../values';
import { deduplicateTopology } from '../../topology-projection';
import { shouldReadTopologyCollection } from '../../topology-scan';
import { datadogInventoryCollection } from './inventory-topology';
import { datadogLogTopology } from './log-topology';
import {
  datadogCatalogCollection,
  datadogTopologyIssue,
  type DatadogCatalogRead,
} from './catalog-topology';

function tagsOf(raw: unknown): Record<string, string> {
  const values: Record<string, string> = {};
  for (const tag of Array.isArray(raw) ? raw : []) {
    if (typeof tag !== 'string') continue;
    const separator = tag.indexOf(':');
    if (separator > 0) values[tag.slice(0, separator)] = tag.slice(separator + 1);
  }
  return values;
}

/** Collect independent catalog and sampled span evidence with separate failure states.
 * @param config - The tenant-owned Datadog account connection.
 * @param createRead - Fresh shared HTTP budget with fixed span and catalog read paths.
 */
export function datadogTopology(
  config: ConnectorConfig,
  createRead: () => {
    spans: () => Promise<unknown>;
    catalog: DatadogCatalogRead;
    logs?: (body: Record<string, unknown>) => Promise<unknown>;
  },
): TopologyReader {
  return {
    async discover(options) {
      const observedAt = new Date().toISOString(),
        read = createRead();
      const collections: TopologyCollection[] = [];
      if (
        config.settings.collectLogs === true &&
        read.logs &&
        shouldReadTopologyCollection(options, 'logs')
      ) {
        const logs = await datadogLogTopology(
          read.logs,
          options?.runtimeScopes ?? [],
          Date.parse(observedAt),
        );
        for (const relation of logs.relations)
          relation.attributes = {
            ...relation.attributes,
            datadogSite: str(config.settings.site) ?? 'datadoghq.com',
          };
        collections.push(logs);
      }
      if (
        config.settings.collectApm !== false &&
        shouldReadTopologyCollection(options, 'apm') &&
        !collections.some((collection) => collection.issue === 'rate_limited')
      ) {
        try {
          const response = await read.spans();
          if (!Array.isArray(obj(response).data)) {
            collections.push({
              key: 'apm',
              completeness: 'unavailable',
              issue: 'invalid_response',
              entities: [],
              relations: [],
            });
          } else collections.push(projectSpans(config, response, observedAt));
        } catch (error) {
          const issue = datadogTopologyIssue(error);
          const delay = Number(obj(error).retryAfterMs);
          collections.push({
            key: 'apm',
            completeness: 'unavailable',
            issue,
            ...(issue === 'rate_limited'
              ? {
                  retryAfterMs: Number.isFinite(delay)
                    ? Math.max(300_000, Math.min(delay, 86_400_000))
                    : 300_000,
                }
              : {}),
            entities: [],
            relations: [],
          });
        }
      }
      for (const kind of ['services', 'dependencies'] as const) {
        if (!shouldReadTopologyCollection(options, `catalog-${kind}`)) continue;
        if (collections.some((collection) => collection.issue === 'rate_limited')) {
          collections.push({
            key: `catalog-${kind}`,
            completeness: 'unavailable',
            issue: 'rate_limited',
            entities: [],
            relations: [],
          });
        } else
          collections.push(
            await datadogCatalogCollection(
              config.id,
              kind,
              read.catalog,
              options?.scans?.[`catalog-${kind}`],
            ),
          );
      }
      for (const kind of ['hosts', 'monitors'] as const) {
        if (!shouldReadTopologyCollection(options, kind)) continue;
        collections.push(
          collections.some((collection) => collection.issue === 'rate_limited')
            ? {
                key: kind,
                completeness: 'unavailable',
                issue: 'rate_limited',
                entities: [],
                relations: [],
              }
            : await datadogInventoryCollection(
                config.id,
                kind,
                read.catalog,
                options?.scans?.[kind],
              ),
        );
      }
      return { observedAt, collections };
    },
  };
}

function projectSpans(
  config: ConnectorConfig,
  payload: unknown,
  observedAt: string,
): TopologyCollection {
  const response = obj(payload);
  if (!Array.isArray(response.data)) throw new Error('Invalid Datadog span discovery response');
  const collection: TopologyCollection = {
    key: 'apm',
    completeness: 'partial',
    issue: 'sampling',
    entities: [],
    relations: [],
  };
  const spans = new Map<
    string,
    { entity: TopologyEntity; parent: string; trace: string; span: string; at: string }
  >();
  const ambiguous = new Set<string>();
  for (const raw of response.data.slice(0, 200)) {
    const attrs = obj(obj(raw).attributes),
      tags = tagsOf(attrs.tags),
      custom = obj(attrs.attributes);
    const service = str(attrs.service),
      env = str(attrs.env) ?? tags.env ?? '';
    const namespace = tags['service.namespace'] ?? str(custom['service.namespace']) ?? '';
    const trace = str(attrs.trace_id),
      span = str(attrs.span_id),
      parent = str(attrs.parent_id);
    const time = str(attrs.start_timestamp);
    if (
      !service ||
      !time ||
      !Number.isFinite(Date.parse(time)) ||
      Date.parse(time) > Date.parse(observedAt)
    )
      continue;
    const at = new Date(time).toISOString();
    const entity: TopologyEntity = {
      ref: {
        authority: `connector:${config.id}`,
        kind: 'service',
        id: JSON.stringify([namespace, env, service]),
      },
      kind: 'service',
      name: service,
      scope: { environment: env, ...(namespace ? { serviceNamespace: namespace } : {}) },
      attributes: { resourceKind: 'APM service' },
      evidenceAt: at,
    };
    collection.entities.push(entity);
    if (!trace || !span) continue;
    const key = JSON.stringify([trace, span]);
    const existing = spans.get(key);
    if (
      existing &&
      (existing.entity.ref.id !== entity.ref.id || existing.parent !== (parent ?? '0'))
    )
      ambiguous.add(key);
    spans.set(key, { entity, parent: parent ?? '0', trace, span, at });
    const podUid = tags['k8s.pod.uid'] ?? str(custom['k8s.pod.uid']);
    const podNamespace =
      tags['k8s.namespace.name'] ?? str(custom['k8s.namespace.name']) ?? tags.kube_namespace;
    if (podUid && podNamespace)
      collection.relations.push({
        from: entity.ref,
        to: {
          authority: 'kubernetes-object',
          kind: 'Pod',
          id: JSON.stringify([podNamespace, podUid]),
        },
        kind: 'runs_on',
        evidence: 'observed',
        description: 'Span resource identifies the Kubernetes pod UID and namespace',
        evidenceAt: at,
        attributes: { traceId: trace, spanId: span },
      });
  }
  for (const [key, child] of spans) {
    const parentKey = JSON.stringify([child.trace, child.parent]),
      parent = spans.get(parentKey);
    if (
      !parent ||
      ambiguous.has(key) ||
      ambiguous.has(parentKey) ||
      child.parent === '0' ||
      parent.entity.ref.id === child.entity.ref.id
    )
      continue;
    collection.relations.push({
      from: parent.entity.ref,
      to: child.entity.ref,
      kind: 'calls',
      evidence: 'observed',
      description: 'Paired parent and child spans from the same trace',
      evidenceAt: child.at,
      scope: {
        callerEnvironment: parent.entity.scope.environment ?? '',
        calleeEnvironment: child.entity.scope.environment ?? '',
      },
      attributes: { traceId: child.trace, parentSpanId: parent.span, childSpanId: child.span },
    });
  }
  return deduplicateTopology(collection);
}
