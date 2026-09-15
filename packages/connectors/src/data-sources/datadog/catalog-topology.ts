import type {
  TopologyCollection,
  TopologyEntity,
  TopologyRef,
  TopologyScanProgress,
} from '@sre/contracts';
import { obj, str } from '../../values';
import { deduplicateTopology } from '../../topology-projection';
import { topologyReadIssue } from '../../topology-transport';
import { finishTopologyPage } from '../../topology-scan';

export type DatadogCatalogRead = (
  path: string,
  query: Record<string, string | number>,
) => Promise<unknown>;

/** Classify a failed Datadog collection without exposing provider messages or credentials. */
export function datadogTopologyIssue(error: unknown): TopologyCollection['issue'] {
  const status = (error as { status?: number } | null)?.status;
  return (
    topologyReadIssue(error) ??
    (status === 401 || status === 403
      ? 'permission_denied'
      : status === 429
        ? 'rate_limited'
        : status === 400 || status === 422
          ? 'request_rejected'
          : error instanceof SyntaxError
            ? 'invalid_response'
            : 'unreachable')
  );
}

const catalogRef = (connectorId: string, id: string): TopologyRef => ({
  authority: `connector:${connectorId}`,
  kind: 'catalog-service',
  id,
});
const reference = (connectorId: string, raw: unknown): TopologyRef | null => {
  const value = obj(raw),
    name = str(value.name),
    namespace = str(value.namespace);
  if (value.kind !== 'service' || !name || !namespace) return null;
  return {
    authority: `connector:${connectorId}`,
    kind: 'catalog-reference',
    id: JSON.stringify(['service', namespace, name]),
  };
};

function service(connectorId: string, raw: unknown): TopologyEntity | null {
  const item = obj(raw),
    attrs = obj(item.attributes),
    id = str(item.id),
    name = str(attrs.name);
  const alias = reference(connectorId, attrs);
  if (!id || !name || !alias) return null;
  const environments = new Set(
    (Array.isArray(attrs.tags) ? attrs.tags : [])
      .filter(
        (tag): tag is string => typeof tag === 'string' && tag.startsWith('env:') && tag.length > 4,
      )
      .map((tag) => tag.slice(4)),
  );
  return {
    ref: catalogRef(connectorId, id),
    aliases: [alias],
    kind: 'service',
    name,
    scope: {
      catalogNamespace: String(attrs.namespace),
      ...(environments.size === 1 ? { environment: [...environments][0]! } : {}),
    },
    attributes: {
      resourceKind: 'Datadog catalog service',
      ...(environments.size > 1 ? { environmentScope: 'Multiple declared environments' } : {}),
    },
  };
}

/** Collect one bounded page sequence of catalog declarations independently of APM span indexes. */
export async function datadogCatalogCollection(
  connectorId: string,
  kind: 'services' | 'dependencies',
  read: DatadogCatalogRead,
  previous?: TopologyScanProgress,
): Promise<TopologyCollection> {
  const collection: TopologyCollection = {
    key: `catalog-${kind}`,
    completeness: 'complete',
    entities: [],
    relations: [],
  };
  const first = previous?.cursor ? Number(previous.cursor) : 0;
  if (!Number.isSafeInteger(first) || first < 0) throw new Error('Invalid Datadog catalog cursor');
  let offset = first,
    cursor: string | null = String(first);
  try {
    for (let page = 0; page < 3; page++) {
      const response = obj(
        await read(kind === 'services' ? '/api/v2/catalog/entity' : '/api/v2/catalog/relation', {
          'page[offset]': offset,
          'page[limit]': 100,
          includeDiscovered: kind === 'services' ? 'true' : 'false',
          ...(kind === 'services'
            ? { 'filter[kind]': 'service' }
            : { 'filter[type]': 'RelationTypeDependsOn' }),
        }),
      );
      if (!Array.isArray(response.data) || response.data.length > 100) {
        collection.completeness = 'partial';
        collection.issue = 'invalid_response';
        break;
      }
      for (const raw of response.data) {
        if (kind === 'services') {
          const entity = service(connectorId, raw);
          if (entity) collection.entities.push(entity);
          else {
            collection.completeness = 'partial';
            collection.issue = 'invalid_response';
          }
        } else {
          const item = obj(raw),
            attrs = obj(item.attributes),
            relationships = obj(item.relationships);
          if (attrs.type !== 'RelationTypeDependsOn') {
            collection.completeness = 'partial';
            collection.issue = 'invalid_response';
            continue;
          }
          // Catalog dependencies on non-service kinds are outside service-to-service impact.
          if (obj(attrs.from).kind !== 'service' || obj(attrs.to).kind !== 'service') continue;
          const fromId = str(obj(obj(relationships.fromEntity).data).id),
            toId = str(obj(obj(relationships.toEntity).data).id);
          const from = fromId
            ? catalogRef(connectorId, fromId)
            : reference(connectorId, attrs.from);
          const to = toId ? catalogRef(connectorId, toId) : reference(connectorId, attrs.to);
          if (!from || !to) {
            collection.completeness = 'partial';
            collection.issue = 'invalid_response';
            continue;
          }
          collection.relations.push({
            from,
            to,
            kind: 'depends_on',
            evidence: 'declared',
            description: 'Datadog Software Catalog dependency declaration; not an observed call',
            ...(str(item.id) ? { attributes: { catalogRelationId: str(item.id)! } } : {}),
          });
        }
      }
      const count = obj(response.meta).count;
      if (!Number.isSafeInteger(count) || Number(count) < offset + response.data.length) {
        collection.completeness = 'partial';
        collection.issue = 'invalid_response';
        break;
      }
      const remaining = offset + response.data.length < Number(count);
      if (remaining && response.data.length === 0) {
        collection.completeness = 'partial';
        collection.issue = 'invalid_response';
        break;
      }
      offset += response.data.length;
      cursor = remaining ? String(offset) : null;
      if (!cursor) break;
    }
  } catch (error) {
    collection.completeness =
      collection.entities.length || collection.relations.length ? 'partial' : 'unavailable';
    collection.issue = datadogTopologyIssue(error);
  }
  return finishTopologyPage(deduplicateTopology(collection), cursor, previous);
}
