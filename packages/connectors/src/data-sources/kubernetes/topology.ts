import {
  topologyRefKey,
  topologyRelationKey,
  type TopologyCollection,
  type TopologyEntity,
  type TopologyReader,
  type TopologyRef,
  type TopologyRelation,
} from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import { obj, str } from '../../values';
import { dnsLookup, type HostLookup } from '../../ssrf';
import { k8sClient, K8sApiError } from './runtime';
import { resourcePath } from './path';
import { repositoryTopologyRef } from '../../repository-topology';
import { topologyFetch, topologyReadIssue } from '../../topology-transport';
import { finishTopologyPage, shouldReadTopologyCollection } from '../../topology-scan';
import { isIP } from 'node:net';

const RESOURCES = [
  ['v1', 'pods', 'Pod'],
  ['apps/v1', 'deployments', 'Deployment'],
  ['apps/v1', 'statefulsets', 'StatefulSet'],
  ['apps/v1', 'daemonsets', 'DaemonSet'],
  ['apps/v1', 'replicasets', 'ReplicaSet'],
  ['batch/v1', 'jobs', 'Job'],
  ['batch/v1', 'cronjobs', 'CronJob'],
  ['v1', 'services', 'Service'],
  ['discovery.k8s.io/v1', 'endpointslices', 'EndpointSlice'],
] as const;

const IDENTITY_LABELS = [
  'app.kubernetes.io/name',
  'app.kubernetes.io/instance',
  'app.kubernetes.io/component',
  'app.kubernetes.io/part-of',
  'tags.datadoghq.com/service',
  'tags.datadoghq.com/env',
] as const;

function ref(authority: string, kind: string, uid: string): TopologyRef {
  return { authority, kind, id: uid };
}

function locator(authority: string, kind: string, namespace: string, name: string): TopologyRef {
  return ref(authority, 'resource', JSON.stringify([kind, namespace, name]));
}

function declaredService(pod: TopologyEntity, annotations: Record<string, unknown>) {
  const value = (key: string) => {
    const text = str(annotations[`resource.opentelemetry.io/${key}`]);
    return text && text.trim() && text.length <= 253 && !/\p{Cc}/u.test(text) ? text : undefined;
  };
  const name = value('service.name');
  if (!name) return null;
  for (const key of ['service.namespace', 'deployment.environment.name'])
    if (annotations[`resource.opentelemetry.io/${key}`] !== undefined && !value(key)) return null;
  const serviceNamespace = value('service.namespace') ?? pod.scope.namespace!;
  const environment = value('deployment.environment.name');
  const service: TopologyEntity = {
    ref: ref(
      pod.ref.authority,
      'declared-service',
      JSON.stringify([pod.scope.namespace, serviceNamespace, environment ?? '', name]),
    ),
    kind: 'service',
    name,
    scope: {
      ...pod.scope,
      serviceNamespace,
      ...(environment ? { environment } : {}),
    },
    attributes: { resourceKind: 'Declared service', provenance: 'opentelemetry_pod_annotation' },
  };
  const relation: TopologyRelation = {
    from: service.ref,
    to: pod.ref,
    kind: 'runs_on',
    evidence: 'declared',
    description: 'Pod explicitly declares its OpenTelemetry service identity; not observed traffic',
  };
  return { service, relation };
}

function datadogService(pod: TopologyEntity, labels: Record<string, unknown>) {
  const valid = (value: unknown): value is string =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 253 &&
    !/\p{Cc}/u.test(value);
  const name = labels['tags.datadoghq.com/service'];
  const environment = labels['tags.datadoghq.com/env'];
  if (!valid(name) || (environment !== undefined && !valid(environment))) return null;
  const service: TopologyEntity = {
    ref: ref(
      pod.ref.authority,
      'datadog-declared-service',
      JSON.stringify([pod.scope.namespace, environment ?? '', name]),
    ),
    kind: 'service',
    name,
    scope: { ...pod.scope, ...(environment !== undefined ? { environment } : {}) },
    attributes: { resourceKind: 'Declared service', provenance: 'datadog_pod_label' },
  };
  const relation: TopologyRelation = {
    from: service.ref,
    to: pod.ref,
    kind: 'runs_on',
    evidence: 'declared',
    description: 'Pod explicitly declares its Datadog service tag; not observed traffic',
  };
  return { service, relation };
}

function project(raw: unknown, kind: string, authority: string, endpoint: string) {
  const item = obj(raw);
  const metadata = obj(item.metadata);
  const name = str(metadata.name);
  const namespace = str(metadata.namespace);
  const uid = str(metadata.uid);
  if (!name || !namespace || !uid) return null;
  const labels = obj(metadata.labels);
  const attributes: Record<string, string> = { resourceKind: kind, uid };
  for (const key of IDENTITY_LABELS) {
    const value = str(labels[key]);
    if (value && value.length <= 253) attributes[key] = value;
  }
  const entity: TopologyEntity = {
    ref: ref(authority, kind, uid),
    kind: kind === 'Service' || kind === 'EndpointSlice' ? 'endpoint' : 'workload',
    name,
    scope: { cluster: authority, namespace },
    attributes,
    aliases: [
      locator(endpoint, kind, namespace, name),
      {
        authority: 'kubernetes-object',
        kind,
        id: JSON.stringify([namespace, uid]),
      },
    ],
  };
  if (kind === 'Pod' || kind === 'Service' || kind === 'EndpointSlice') {
    const spec = obj(item.spec),
      status = obj(item.status);
    const rawAddresses =
      kind === 'EndpointSlice'
        ? Array.isArray(item.endpoints)
          ? item.endpoints.flatMap((entry) => obj(entry).addresses ?? [])
          : []
        : kind === 'Pod'
          ? Array.isArray(status.podIPs)
            ? status.podIPs.map((entry) => obj(entry).ip)
            : [status.podIP]
          : Array.isArray(spec.clusterIPs)
            ? spec.clusterIPs
            : [spec.clusterIP];
    const rawPorts =
      kind === 'EndpointSlice'
        ? item.ports
        : kind === 'Service'
          ? spec.ports
          : Array.isArray(spec.containers)
            ? spec.containers.flatMap((entry) => obj(entry).ports ?? [])
            : [];
    entity.network = {
      addresses: [
        ...new Set(
          (kind === 'Pod' && spec.hostNetwork === true ? [] : rawAddresses)
            .filter((value): value is string => typeof value === 'string' && isIP(value) !== 0)
            .map((value) =>
              isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value,
            ),
        ),
      ].sort(),
      ports: [
        ...new Set(
          (Array.isArray(rawPorts) ? rawPorts : []).flatMap((entry) => {
            const port = obj(entry),
              value = kind === 'Pod' ? port.containerPort : port.port;
            return (!port.protocol || port.protocol === 'TCP') &&
              typeof value === 'number' &&
              Number.isInteger(value) &&
              value > 0 &&
              value <= 65535
              ? [value]
              : [];
          }),
        ),
      ].sort((a, b) => a - b),
    };
  }
  const relations: TopologyRelation[] = [];
  const repositories: TopologyEntity[] = [];
  const services: TopologyEntity[] = [];
  if (kind === 'Pod') {
    const annotations = obj(metadata.annotations);
    for (const declaration of [
      declaredService(entity, annotations),
      datadogService(entity, labels),
    ]) {
      if (declaration) {
        services.push(declaration.service);
        relations.push(declaration.relation);
      }
    }
    const source = str(annotations['org.opencontainers.image.source']);
    const repository = source ? repositoryTopologyRef(source) : null;
    const revision = str(annotations['org.opencontainers.image.revision']);
    if (repository) {
      repositories.push({
        ref: repository,
        kind: 'repository',
        name: repository.id,
        scope: {},
        attributes: { evidence: 'pod_declaration' },
      });
      relations.push({
        from: entity.ref,
        to: repository,
        kind: 'deployed_from',
        evidence: 'declared',
        attributes: {
          role: 'application_source',
          provenance: 'pod_annotation',
          ...(/^[0-9a-f]{40,64}$/i.test(revision ?? '')
            ? { revision: revision!.toLowerCase() }
            : {}),
        },
        description: 'Pod source declaration, not verified container image provenance',
      });
    }
  }
  for (const owner of Array.isArray(metadata.ownerReferences) ? metadata.ownerReferences : []) {
    const parent = obj(owner);
    const ownerKind = str(parent.kind);
    const ownerUid = str(parent.uid);
    if (ownerKind && ownerUid && parent.controller === true) {
      relations.push({
        from: ref(authority, ownerKind, ownerUid),
        to: entity.ref,
        kind: 'owns',
        evidence: 'provider_reference',
        description: 'Kubernetes controller owner reference',
      });
    }
  }
  if (kind === 'EndpointSlice') {
    const service = str(labels['kubernetes.io/service-name']);
    for (const endpointEntry of Array.isArray(item.endpoints) ? item.endpoints : []) {
      const target = obj(obj(endpointEntry).targetRef);
      if (
        service &&
        str(target.uid) &&
        str(target.kind) &&
        (!target.namespace || target.namespace === namespace)
      ) {
        relations.push({
          from: locator(endpoint, 'Service', namespace, service),
          to: ref(authority, str(target.kind)!, str(target.uid)!),
          kind: 'routes_to',
          evidence: 'provider_reference',
          description: 'Kubernetes EndpointSlice target reference',
        });
      }
    }
  }
  return { entity, relations, repositories, services };
}

/** Discover controller ownership and Service routing without treating names as service identities.
 * @param config - Tenant-owned Kubernetes connection and its optional namespace restriction.
 * @param fetchImpl - Guarded transport dependency.
 * @param lookup - Resolver used by the existing Kubernetes SSRF guard.
 */
export function kubernetesTopology(
  config: ConnectorConfig,
  fetchImpl: typeof fetch = fetch,
  lookup: HostLookup = dnsLookup,
): TopologyReader {
  return {
    async discover(options) {
      const observedAt = new Date().toISOString();
      const { kjson } = await k8sClient(config, topologyFetch(fetchImpl), lookup);
      const namespace = str(config.settings.namespace);
      const url = new URL(str(config.settings.apiUrl)!);
      // No credential-bearing query, userinfo or fragment enters topology identity.
      const endpoint = `kubernetes:${url.origin}${url.pathname.replace(/\/$/, '')}`;
      let authority = options?.clusterAuthority;
      if (!authority)
        try {
          const cluster = obj(await kjson('/api/v1/namespaces/kube-system'));
          const uid = str(obj(cluster.metadata).uid);
          if (!uid) throw new Error('Invalid Kubernetes cluster identity');
          authority = `kubernetes-cluster:${uid}`;
        } catch (error) {
          // A permanent namespace permission boundary may use the stable endpoint identity.
          if (namespace && error instanceof K8sApiError && error.status === 403)
            authority = endpoint;
          else throw error;
        }
      const collections: TopologyCollection[] = [];
      for (const [apiVersion, resource, kind] of RESOURCES) {
        if (!shouldReadTopologyCollection(options, resource)) continue;
        const collection: TopologyCollection = {
          key: resource,
          completeness: 'complete',
          entities: [],
          relations: [],
        };
        const initial = `${resourcePath(apiVersion, resource, { namespace })}?limit=200`;
        const previous = options?.scans?.[resource];
        let continuation = previous?.cursor ?? null;
        let path: string | undefined = continuation
          ? `${initial}&continue=${encodeURIComponent(continuation)}`
          : initial;
        try {
          for (let page = 0; path && page < 5; page += 1) {
            const response = obj(await kjson(path));
            if (!Array.isArray(response.items)) {
              collection.completeness = 'partial';
              collection.issue = 'invalid_response';
              break;
            }
            for (const raw of response.items) {
              const projected = project(raw, kind, authority, endpoint);
              if (!projected || (namespace && projected.entity.scope.namespace !== namespace)) {
                collection.completeness = 'partial';
                collection.issue = 'invalid_response';
                continue;
              }
              collection.entities.push(projected.entity);
              collection.entities.push(...projected.repositories);
              collection.entities.push(...projected.services);
              collection.relations.push(...projected.relations);
            }
            continuation = str(obj(response.metadata).continue) ?? null;
            path = continuation
              ? `${initial}&continue=${encodeURIComponent(continuation)}`
              : undefined;
          }
        } catch (error) {
          collection.completeness = collection.entities.length ? 'partial' : 'unavailable';
          collection.issue =
            topologyReadIssue(error) ??
            (error instanceof K8sApiError && error.status === 403
              ? 'permission_denied'
              : error instanceof K8sApiError && error.status === 429
                ? 'rate_limited'
                : 'unreachable');
          if (error instanceof K8sApiError && error.status === 410) {
            // Expired snapshots restart later without treating the interrupted scan as authoritative.
            continuation = null;
            collection.completeness = 'partial';
            collection.issue = 'limit';
          }
        }
        collection.entities = [
          ...new Map(collection.entities.map((e) => [topologyRefKey(e.ref), e])).values(),
        ];
        collection.relations = [
          ...new Map(collection.relations.map((r) => [topologyRelationKey(r), r])).values(),
        ];
        collections.push(finishTopologyPage(collection, continuation, previous));
      }
      return { observedAt, collections };
    },
  };
}
