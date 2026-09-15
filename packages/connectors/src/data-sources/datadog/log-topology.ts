import { isIP } from 'node:net';
import type {
  TopologyCollection,
  TopologyRef,
  TopologyRelation,
  TopologyRuntimeScope,
} from '@sre/contracts';
import { obj, str } from '../../values';
import { deduplicateTopology } from '../../topology-projection';
import { datadogTopologyIssue } from './catalog-topology';

type ReadLogs = (body: Record<string, unknown>) => Promise<unknown>;
const separator = '(?:,\\s*|\\s+:\\s+)';
const upstream = '(?:(?:\\[[0-9a-f:]+\\]|[0-9.]+):\\d{1,5}|-)';
const numeric = '(?:\\d+(?:\\.\\d+)?|-)';
const numbers = `${numeric}(?:${separator}${numeric})*`;
const ingress = new RegExp(
  '^\\S+ - \\S+ \\[[^\\]\\r\\n]+\\] "[A-Z]+ [^"\\r\\n]* HTTP\\/[\\d.]+" \\d{3} \\S+ "[^"\\r\\n]*" "[^"\\r\\n]*" \\S+ \\S+ \\[([^\\]\\r\\n]*)\\] \\[([^\\]\\r\\n]*)\\] ' +
    `(${upstream}(?:${separator}${upstream})*) ${numbers} ${numbers} (${numbers}) \\S+$`,
  'i',
);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const name = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,252}$/.test(value);

function address(value: string): { ip: string; port: number } | null {
  const match = value.match(/^(?:\[([0-9a-f:]+)\]|([0-9.]+)):(\d{1,5})$/i);
  if (!match) return null;
  let ip = match[1] ?? match[2]!;
  const port = Number(match[3]);
  if (
    !isIP(ip) ||
    port < 1 ||
    port > 65535 ||
    ip.startsWith('127.') ||
    ip === '::1' ||
    ip === '0.0.0.0'
  )
    return null;
  if (isIP(ip) === 6) ip = new URL(`http://[${ip}]`).hostname.slice(1, -1);
  if (ip === '::1' || ip.startsWith('::ffff:7f')) return null;
  return { ip, port };
}

function tags(value: unknown) {
  const out = new Map<string, Set<string>>();
  for (const raw of Array.isArray(value) ? value : []) {
    if (typeof raw !== 'string') continue;
    const split = raw.indexOf(':');
    if (split < 1) continue;
    const key = raw.slice(0, split),
      values = out.get(key) ?? new Set();
    values.add(raw.slice(split + 1));
    out.set(key, values);
  }
  return (key: string) => {
    const values = out.get(key);
    return values?.size === 1 ? [...values][0] : undefined;
  };
}

/** Parse a supported request record without retaining log bodies or caller-controlled request data.
 * @param raw - Datadog event with reserved attributes and Kubernetes tags.
 * @param scopes - Verified tenant Kubernetes namespaces.
 * @param from - Frozen start of the bounded evidence window.
 * @param to - Frozen end of the bounded evidence window.
 */
export function datadogLogRelations(
  raw: unknown,
  scopes: TopologyRuntimeScope[],
  from: string,
  to: string,
): TopologyRelation[] {
  const attrs = obj(obj(raw).attributes),
    tag = tags(attrs.tags),
    cluster = tag('orch_cluster_id');
  const namespace = tag('kube_namespace'),
    pod = tag('pod_name'),
    at = str(attrs.timestamp);
  if (
    !cluster ||
    !scopes.some((scope) => scope.clusterId === cluster && scope.namespace === namespace) ||
    !name(namespace) ||
    !name(pod) ||
    !at ||
    !Number.isFinite(Date.parse(at)) ||
    Date.parse(at) < Date.parse(from) ||
    Date.parse(at) > Date.parse(to)
  )
    return [];
  const authority = `kubernetes-traffic:${cluster}`;
  const source: TopologyRef = { authority, kind: 'pod_name', id: JSON.stringify([namespace, pod]) };
  const ref = (kind: string, identity: unknown[]): TopologyRef => ({
    authority,
    kind,
    id: JSON.stringify(identity),
  });
  const relation = (
    fromRef: TopologyRef,
    toRef: TopologyRef,
    parser: string,
    outcome: string,
  ): TopologyRelation => ({
    from: fromRef,
    to: toRef,
    kind: 'calls',
    evidence: 'observed',
    evidenceAt: at,
    // Keep an older sample until the next inventory read can bracket its endpoint ownership.
    scope: {
      observationWindow: new Date(Math.floor(Date.parse(at) / 60_000) * 60_000).toISOString(),
    },
    description:
      'Request observed in a bounded log sample. Endpoint ownership requires time-valid inventory.',
    attributes: {
      parser,
      outcome,
      windowStart: from,
      windowEnd: to,
      logQuery: `orch_cluster_id:${cluster} kube_namespace:${namespace} pod_name:${pod}`,
      sourceCluster: cluster,
      sourceNamespace: namespace,
    },
  });
  const custom = obj(attrs.attributes);
  const field = (key: string) =>
    custom[key] ?? key.split('.').reduce<unknown>((value, part) => obj(value)[part], custom);
  const component = field('grpc.component'),
    code = field('grpc.code'),
    peer = str(field('peer.address'));
  if (
    (component === 'server' || component === 'client') &&
    typeof code === 'string' &&
    /^[A-Za-z_]{1,32}$/.test(code) &&
    peer
  ) {
    const target = address(peer);
    if (!target) return [];
    return [
      component === 'server'
        ? relation(ref('pod_address', [target.ip]), source, 'grpc-server', 'response_recorded')
        : relation(
            source,
            ref('tcp_address', [target.ip, target.port]),
            'grpc-client',
            code === 'OK' ? 'response_recorded' : 'attempt_recorded',
          ),
    ];
  }
  const message = str(attrs.message);
  if (!message || message.length > 16384) return [];
  const match = message.match(ingress);
  if (!match) return [];
  const targets = match[3]!.split(/,\s*|\s+:\s+/),
    statuses = match[4]!.split(/,\s*|\s+:\s+/);
  if (targets.length !== statuses.length || targets.length > 16) return [];
  return targets.flatMap((value, index) => {
    const target = address(value.trim());
    if (!target) return [];
    const status = Number(statuses[index]);
    // Gateway errors can be generated by the proxy without a response from its upstream.
    const outcome =
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599 &&
      ![502, 503, 504].includes(status)
        ? 'response_recorded'
        : 'attempt_recorded';
    return [
      relation(source, ref('tcp_address', [target.ip, target.port]), 'ingress-nginx', outcome),
    ];
  });
}

/** Sample independent request schemas under one fixed window and a three-request budget.
 * @param read - Host-confined, bounded log-search transport.
 * @param scopes - Only verified tenant runtime namespaces may contribute log evidence.
 * @param now - Collection time used to freeze the sample window.
 */
export async function datadogLogTopology(
  read: ReadLogs,
  scopes: TopologyRuntimeScope[],
  now = Date.now(),
): Promise<TopologyCollection> {
  const collection: TopologyCollection = {
    runtimeScopes: scopes,
    key: 'logs',
    completeness: 'partial',
    issue: 'sampling',
    entities: [],
    relations: [],
  };
  const eligible = [
    ...new Map(
      scopes
        .filter((scope) => UUID.test(scope.clusterId) && name(scope.namespace))
        .map((scope) => [JSON.stringify(scope), scope]),
    ).values(),
  ].sort(
    (a, b) => a.clusterId.localeCompare(b.clusterId) || a.namespace.localeCompare(b.namespace),
  );
  const admitted = eligible.slice(0, 64);
  if (!admitted.length) return { ...collection, issue: 'missing_scope' };
  const from = new Date(now - 600_000).toISOString(),
    to = new Date(now).toISOString();
  const scope = `(${admitted.map((item) => `(orch_cluster_id:${item.clusterId} AND kube_namespace:${item.namespace})`).join(' OR ')})`;
  const filters = [
    '"HTTP/"',
    '@grpc.component:server @grpc.code:* @peer.address:*',
    '@grpc.component:client @grpc.code:* @peer.address:*',
  ];
  const seen = new Set<string>();
  try {
    for (const filter of filters) {
      const response = obj(
        await read({
          filter: { query: `${scope} AND (${filter})`, from, to },
          sort: '-timestamp',
          page: { limit: 200 },
        }),
      );
      if (!Array.isArray(response.data))
        return deduplicateTopology({ ...collection, issue: 'invalid_response' });
      if (obj(obj(response.meta).page).after || eligible.length > admitted.length)
        collection.issue = 'limit';
      for (const raw of response.data.slice(0, 200)) {
        const id = str(obj(raw).id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        collection.relations.push(...datadogLogRelations(raw, admitted, from, to));
      }
    }
  } catch (error) {
    collection.issue = datadogTopologyIssue(error);
    if (collection.issue === 'rate_limited') {
      const delay = Number(obj(error).retryAfterMs);
      collection.retryAfterMs = Number.isFinite(delay)
        ? Math.max(300_000, Math.min(delay, 86_400_000))
        : 300_000;
    }
    if (!collection.relations.length) collection.completeness = 'unavailable';
  }
  if (collection.issue === 'sampling' && !collection.relations.length)
    collection.issue = seen.size ? 'unsupported_schema' : 'no_matches';
  return deduplicateTopology(collection);
}
