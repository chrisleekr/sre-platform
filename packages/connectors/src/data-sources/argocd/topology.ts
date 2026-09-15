import {
  topologyRefKey,
  topologyRelationKey,
  type TopologyCollection,
  type TopologyReader,
} from '@sre/contracts';
import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import { obj, str } from '../../values';
import { repositoryTopologyRef } from '../../repository-topology';
import { topologyFetch, topologyReadIssue, TopologyReadError } from '../../topology-transport';
import { finishTopologyPage, shouldReadTopologyCollection } from '../../topology-scan';
import { ArgoApiError, connect, checkedJsonGet, validateName, type FetchLike } from './client';
import { readApplications, readScopedApplication } from './verification';
import { safeHttpUrl } from './projection';

/** Discover application management and source relationships inside the configured project scope.
 * @param config - Authorized application scopes and project credentials.
 * @param fetchImpl - Existing Argo CD transport.
 * @param lookup - Resolver for the connector's SSRF guard.
 */
export function argoTopology(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
): TopologyReader {
  return {
    async discover(options) {
      const observedAt = new Date().toISOString();
      if (!shouldReadTopologyCollection(options, 'applications'))
        return { observedAt, collections: [] };
      const transport = topologyFetch(fetchImpl);
      const client = await connect(config, lookup);
      const previous = options?.scans?.applications;
      // Older numeric checkpoints have no fixed inventory; restart them to avoid offset omissions.
      const applications = previous?.inventory
        ? undefined
        : await readApplications(config, transport, client, 5000);
      const inventory =
        previous?.inventory ??
        applications!
          .flatMap((raw) => {
            const meta = obj(obj(raw).metadata);
            const id = str(meta.uid),
              name = str(meta.name),
              namespace = str(meta.namespace);
            return id && name ? [{ id, name, ...(namespace ? { namespace } : {}) }] : [];
          })
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const offset = previous?.inventory && previous.cursor ? Number(previous.cursor) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > inventory.length)
        throw new Error('Invalid application scan offset');
      const initial = new Map(applications?.map((raw) => [str(obj(obj(raw).metadata).uid), raw]));
      const collection: TopologyCollection = {
        key: 'applications',
        completeness: 'complete',
        entities: [],
        relations: [],
      };
      if (applications && inventory.length !== applications.length) {
        collection.completeness = 'partial';
        collection.issue = 'invalid_response';
      }
      let nextOffset = offset;
      for (const [pageIndex, identity] of inventory.slice(offset, offset + 25).entries()) {
        nextOffset = offset + pageIndex + 1;
        let raw: unknown;
        try {
          raw =
            initial.get(identity.id) ??
            (await readScopedApplication(
              config,
              transport,
              client,
              validateName('name', identity.name),
              config.settings.applicationsInAnyNamespace === true ? identity.namespace : undefined,
            ));
          if (str(obj(obj(raw).metadata).uid) !== identity.id) {
            collection.completeness = 'partial';
            collection.issue = 'invalid_response';
            continue;
          }
        } catch (error) {
          if (error instanceof TopologyReadError && error.deadlineExceeded) {
            nextOffset = offset + pageIndex;
            break;
          }
          collection.completeness = 'partial';
          collection.issue =
            topologyReadIssue(error) ??
            (error instanceof ArgoApiError && error.failureCategory === 'permission_denied'
              ? 'permission_denied'
              : 'unreachable');
          continue;
        }
        const app = obj(raw),
          meta = obj(app.metadata),
          spec = obj(app.spec),
          status = obj(app.status);
        const name = str(meta.name),
          uid = str(meta.uid),
          namespace = str(meta.namespace);
        if (!name || !uid) {
          collection.completeness = 'partial';
          collection.issue = 'invalid_response';
          continue;
        }
        const appRef = { authority: `connector:${config.id}`, kind: 'application', id: uid };
        collection.entities.push({
          ref: appRef,
          kind: 'deployment',
          name,
          scope: { project: str(spec.project) || 'default', ...(namespace ? { namespace } : {}) },
          attributes: { resourceKind: 'Application' },
        });
        const sources = Array.isArray(spec.sources)
          ? spec.sources
          : spec.source
            ? [spec.source]
            : [];
        const sync = obj(status.sync);
        const resolved = Array.isArray(sync.revisions) ? sync.revisions : [sync.revision];
        sources.forEach((rawSource, index) => {
          const source = obj(rawSource),
            repo = str(source.repoURL);
          // Helm chart registries are not source repositories.
          const repoRef = repo && !source.chart ? repositoryTopologyRef(repo) : null;
          if (!repoRef) return;
          collection.entities.push({
            ref: repoRef,
            kind: 'repository',
            name: repoRef.id,
            scope: {},
            attributes: { evidence: 'deployment_configuration' },
          });
          collection.relations.push({
            from: appRef,
            to: repoRef,
            kind: 'deployed_from',
            evidence: 'declared',
            scope: { path: str(source.path) ?? '', sourceIndex: String(index) },
            attributes: {
              role: 'deployment_config',
              ...(str(resolved[index]) ? { revision: str(resolved[index])! } : {}),
            },
            description: 'Application deployment configuration, not necessarily application source',
          });
        });
        const server = safeHttpUrl(obj(spec.destination).server);
        if (!server) continue; // Named destinations need a separately authorized cluster identity read.
        const url = new URL(server);
        const authority = `kubernetes:${url.origin}${url.pathname.replace(/\/$/, '')}`;
        try {
          const tree = obj(
            await checkedJsonGet(
              transport,
              client,
              `/api/v1/applications/${encodeURIComponent(validateName('name', name))}/resource-tree`,
              {
                appNamespace:
                  config.settings.applicationsInAnyNamespace === true ? namespace : undefined,
              },
            ),
          );
          if (!Array.isArray(tree.nodes)) throw new Error('Invalid resource tree');
          if (tree.nodes.length > 200) {
            collection.completeness = 'partial';
            collection.issue = 'limit';
          }
          for (const rawNode of tree.nodes.slice(0, 200)) {
            const node = obj(rawNode);
            const kind = str(node.kind),
              resourceName = str(node.name),
              ns = str(node.namespace);
            // Secret/ConfigMap content and unrelated resource kinds never enter discovery.
            if (
              !kind ||
              !resourceName ||
              !ns ||
              ![
                'Deployment',
                'StatefulSet',
                'DaemonSet',
                'ReplicaSet',
                'Pod',
                'Job',
                'CronJob',
                'Service',
              ].includes(kind)
            )
              continue;
            const resourceUid = str(node.uid);
            const ref = resourceUid
              ? { authority: 'kubernetes-object', kind, id: JSON.stringify([ns, resourceUid]) }
              : { authority, kind: 'resource', id: JSON.stringify([kind, ns, resourceName]) };
            collection.entities.push({
              ref,
              kind: kind === 'Service' ? 'endpoint' : 'workload',
              name: resourceName,
              scope: { namespace: ns },
              attributes: { resourceKind: kind, ...(str(node.uid) ? { uid: str(node.uid)! } : {}) },
            });
            collection.relations.push({
              from: appRef,
              to: ref,
              kind: 'manages',
              evidence: 'provider_reference',
              description: 'Argo CD application resource tree',
            });
          }
        } catch (error) {
          collection.completeness = 'partial';
          collection.issue =
            topologyReadIssue(error) ??
            (error instanceof ArgoApiError && error.failureCategory === 'permission_denied'
              ? 'permission_denied'
              : 'unreachable');
          if (error instanceof TopologyReadError && error.deadlineExceeded) break;
        }
      }
      collection.entities = [
        ...new Map(collection.entities.map((e) => [topologyRefKey(e.ref), e])).values(),
      ];
      collection.relations = [
        ...new Map(collection.relations.map((r) => [topologyRelationKey(r), r])).values(),
      ];
      const next = nextOffset < inventory.length ? String(nextOffset) : null;
      const finished = finishTopologyPage(collection, next, previous);
      if (next) finished.scan!.inventory = inventory;
      return { observedAt, collections: [finished] };
    },
  };
}
