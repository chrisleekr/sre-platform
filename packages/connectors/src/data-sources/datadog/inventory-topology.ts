import type { TopologyCollection, TopologyEntity, TopologyScanProgress } from '@sre/contracts';
import { obj, str } from '../../values';
import { finishTopologyPage } from '../../topology-scan';
import { deduplicateTopology } from '../../topology-projection';
import { datadogTopologyIssue, type DatadogCatalogRead } from './catalog-topology';

const pageSize = 100;

function tagValue(tags: string[], key: string): string | undefined {
  const values = [
    ...new Set(
      tags.filter((tag) => tag.startsWith(`${key}:`)).map((tag) => tag.slice(key.length + 1)),
    ),
  ];
  return values.length === 1 && values[0]!.length > 0 && values[0]!.length <= 255
    ? values[0]
    : undefined;
}

function project(
  connectorId: string,
  kind: 'hosts' | 'monitors',
  raw: unknown,
  collection: TopologyCollection,
) {
  const item = obj(raw);
  const id =
    typeof item.id === 'number' && Number.isSafeInteger(item.id)
      ? String(item.id)
      : (str(item.id) ?? str(item.aws_id));
  const name = str(kind === 'hosts' ? item.host_name : item.name);
  if (!id || !name) {
    collection.completeness = 'partial';
    collection.issue = 'invalid_response';
    return;
  }
  const rawTags = kind === 'hosts' ? Object.values(obj(item.tags_by_source)).flat() : item.tags;
  const tags = (Array.isArray(rawTags) ? rawTags : []).filter(
    (tag): tag is string => typeof tag === 'string',
  );
  const env = tagValue(tags, 'env');
  const entity: TopologyEntity = {
    ref: {
      authority: `connector:${connectorId}`,
      kind: kind === 'hosts' ? 'datadog-host' : 'datadog-monitor',
      id,
    },
    kind: kind === 'hosts' ? 'host' : 'monitor',
    name: name.slice(0, 512),
    scope: env ? { environment: env } : {},
    attributes: {
      resourceKind: kind === 'hosts' ? 'Datadog host' : 'Datadog monitor',
      ...(kind === 'monitors' && str(item.type)
        ? { monitorType: str(item.type)!.slice(0, 100) }
        : {}),
    },
  };
  if (kind === 'hosts' && item.last_reported_time !== undefined) {
    const at = typeof item.last_reported_time === 'number' ? item.last_reported_time * 1000 : NaN;
    if (!Number.isFinite(at) || at <= 0 || at > Date.now()) {
      collection.completeness = 'partial';
      collection.issue = 'invalid_response';
      return;
    }
    entity.evidenceAt = new Date(at).toISOString();
  }
  collection.entities.push(entity);
  const serviceName = tagValue(tags, 'service');
  if (!serviceName || (tags.some((tag) => tag.startsWith('env:')) && !env)) return;
  const service: TopologyEntity = {
    ref: {
      authority: `connector:${connectorId}`,
      kind: 'tagged-service',
      id: JSON.stringify([env ?? '', serviceName]),
    },
    kind: 'service',
    name: serviceName,
    scope: env ? { environment: env } : {},
    attributes: { resourceKind: 'Datadog service tag declaration' },
    ...(entity.evidenceAt ? { evidenceAt: entity.evidenceAt } : {}),
  };
  collection.entities.push(service);
  collection.relations.push({
    from: kind === 'hosts' ? service.ref : entity.ref,
    to: kind === 'hosts' ? entity.ref : service.ref,
    kind: kind === 'hosts' ? 'runs_on' : 'monitors',
    evidence: 'declared',
    description:
      kind === 'hosts'
        ? 'Host service tag declares runtime association'
        : 'Monitor service tag declares monitoring scope',
    ...(entity.evidenceAt ? { evidenceAt: entity.evidenceAt } : {}),
  });
}

/** Read host and monitor inventory without APM, raw queries, host metadata or inferred calls.
 * @param connectorId - Tenant-owned source identity.
 * @param kind - Fixed read-only inventory endpoint.
 * @param read - Shared bounded Datadog transport.
 * @param previous - Durable cursor from the previous batch.
 */
export async function datadogInventoryCollection(
  connectorId: string,
  kind: 'hosts' | 'monitors',
  read: DatadogCatalogRead,
  previous?: TopologyScanProgress,
): Promise<TopologyCollection> {
  const collection: TopologyCollection = {
    key: kind,
    completeness: 'complete',
    entities: [],
    relations: [],
  };
  let page = previous?.cursor ? Number(previous.cursor) : 0;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid Datadog inventory cursor');
  let cursor: string | null = String(page);
  try {
    for (let batch = 0; batch < 3; batch++) {
      const response = await read(
        kind === 'hosts' ? '/api/v1/hosts' : '/api/v1/monitor',
        kind === 'hosts'
          ? {
              start: page * pageSize,
              count: pageSize,
              include_hosts_metadata: 0,
              sort_field: 'host_name',
              sort_dir: 'asc',
            }
          : { page, page_size: pageSize },
      );
      const items = kind === 'hosts' ? obj(response).host_list : response;
      if (!Array.isArray(items)) throw new SyntaxError('Invalid Datadog inventory');
      const total = obj(response).total_matching;
      if (
        items.length > pageSize ||
        (kind === 'hosts' &&
          (typeof total !== 'number' ||
            !Number.isSafeInteger(total) ||
            total < 0 ||
            items.length !== Math.min(pageSize, Math.max(0, total - page * pageSize))))
      )
        throw new SyntaxError('Invalid Datadog inventory pagination');
      for (const item of items) project(connectorId, kind, item, collection);
      const more =
        kind === 'hosts' && typeof total === 'number'
          ? (page + 1) * pageSize < total
          : items.length >= pageSize;
      page++;
      cursor = more ? String(page) : null;
      if (!more) break;
    }
  } catch (error) {
    collection.completeness = collection.entities.length ? 'partial' : 'unavailable';
    collection.issue = datadogTopologyIssue(error);
  }
  return finishTopologyPage(deduplicateTopology(collection), cursor, previous);
}
