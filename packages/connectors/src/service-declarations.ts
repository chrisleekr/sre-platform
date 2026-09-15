import { parseAllDocuments } from 'yaml';
import {
  topologyRefKey,
  topologyRelationKey,
  type TopologyEntity,
  type TopologyRef,
  type TopologyRelation,
} from '@sre/contracts';
import { obj } from './values';

const validName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9](?:[a-z0-9_.-]{0,61}[a-z0-9])?$/i.test(value);

/** Project explicit service descriptors without interpreting lifecycle as deployment environment.
 * @param repository - Exact admitted source repository identity.
 * @param path - Revision-pinned descriptor path within the admitted component.
 * @param revision - Immutable source commit, not a deployed revision assertion.
 * @param text - Bounded source text. Arbitrary fields and substitutions are never retained or fetched.
 */
export function serviceDeclarations(
  repository: TopologyRef,
  path: string,
  revision: string,
  text: string,
) {
  if (Buffer.byteLength(text, 'utf8') > 65536) throw new Error('Service descriptor exceeds limit');
  const documents = parseAllDocuments(text, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (documents.length > 50) throw new Error('Too many service descriptors');
  const entities: TopologyEntity[] = [],
    relations: TopologyRelation[] = [];
  const ref = (namespace: string, name: string): TopologyRef => ({
    authority: `source-catalog:${topologyRefKey(repository)}`,
    kind: 'component',
    id: JSON.stringify([namespace.toLowerCase(), name.toLowerCase()]),
  });
  for (const document of documents) {
    if (document.errors.length || document.warnings.length)
      throw new Error('Invalid service descriptor');
    const data = obj(document.toJS({ maxAliasCount: 0 }));
    if (data.apiVersion !== 'backstage.io/v1alpha1' || data.kind !== 'Component') continue;
    const metadata = obj(data.metadata),
      spec = obj(data.spec);
    if (spec.type !== 'service') continue;
    const name = metadata.name,
      namespace = metadata.namespace ?? 'default';
    if (!validName(name) || !validName(namespace)) throw new Error('Invalid service identity');
    const entity: TopologyEntity = {
      ref: ref(namespace, name),
      kind: 'service',
      name,
      scope: { serviceNamespace: namespace.toLowerCase() },
      attributes: {
        resourceKind: 'Source-declared service',
        descriptorPath: path,
        revision,
        provenance: 'backstage_component',
      },
    };
    entities.push(entity);
    relations.push({
      from: entity.ref,
      to: repository,
      kind: 'declared_in',
      evidence: 'declared',
      scope: { path },
      attributes: { revision, provenance: 'source_descriptor' },
      description: 'Service descriptor at a source commit; not evidence of deployment',
    });
    if (spec.dependsOn === undefined) continue;
    if (!Array.isArray(spec.dependsOn) || spec.dependsOn.length > 100)
      throw new Error('Invalid dependency declarations');
    for (const dependency of spec.dependsOn) {
      if (typeof dependency !== 'string') throw new Error('Invalid dependency reference');
      const match = /^(?:(component|resource):)?(?:([^/:]+)\/)?([^/:]+)$/i.exec(dependency);
      if (!match || !validName(match[2] ?? namespace) || !validName(match[3]))
        throw new Error('Invalid dependency reference');
      // No catalog-instance identity exists to authorize cross-repository name joins.
      if (match[1]?.toLowerCase() === 'resource') continue;
      relations.push({
        from: entity.ref,
        to: ref(match[2] ?? namespace, match[3]!),
        kind: 'depends_on',
        evidence: 'declared',
        scope: { path },
        attributes: { revision },
        description:
          'Source-declared dependency; target must resolve within this repository catalog',
      });
    }
  }
  const seen = new Set<string>();
  for (const entity of entities) {
    const key = topologyRefKey(entity.ref);
    if (seen.has(key)) throw new Error('Duplicate service declaration');
    seen.add(key);
  }
  return {
    entities,
    relations: [
      ...new Map(relations.map((relation) => [topologyRelationKey(relation), relation])).values(),
    ],
  };
}
