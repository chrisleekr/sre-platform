import { and, eq, isNull, lt } from 'drizzle-orm';
import {
  hasKnownCredential,
  isSensitiveKey,
  scrubSecrets,
  topologyRefKey,
  topologyRelationKey,
  type ObservedTopologyFact,
  type TopologyDiscovery,
  type TopologyCollection,
  type TopologyScanProgress,
  type TopologyEntity,
  type TopologyRelation,
  type TopologyRuntimeScope,
} from '@sre/contracts';
import type { Db } from './client';
import { withTenant } from './rls';
import { connectorConfigs, topologyCollections } from './schema';
import { runtimeScopesFromInventory } from './topology-runtime-scope';

const MAX_FACTS = 10_000;
const MAX_INVENTORY_BYTES = 4_000_000;
const READER_STATUS = '__discovery__';

function mergeFacts<T extends { evidenceAt?: string; network?: TopologyEntity['network'] }>(
  previous: ObservedTopologyFact<T>[],
  next: T[],
  at: string,
  complete: boolean,
  key: (value: T) => string,
  retainBindings = false,
  retainedSince: string | null = null,
): { facts: ObservedTopologyFact<T>[]; truncated: boolean } {
  const values = new Map(
    previous
      .filter(
        (fact) =>
          !complete ||
          (retainedSince !== null && (fact.seenAt ?? fact.observedAt) >= retainedSince),
      )
      .filter((fact) => !fact.retired || Date.parse(at) - Date.parse(fact.observedAt) <= 86_400_000)
      .map((fact) => [key(fact.value), fact]),
  );
  const prior = new Map(previous.map((fact) => [key(fact.value), fact]));
  if (retainBindings && complete)
    for (const fact of previous)
      if (
        !values.has(key(fact.value)) &&
        fact.value.network &&
        Date.parse(at) - Date.parse(fact.observedAt) <= 86_400_000
      )
        values.set(key(fact.value), { ...fact, retired: true });
  for (const value of next) {
    const observedAt = value.evidenceAt ? new Date(value.evidenceAt).toISOString() : at;
    const old = values.get(key(value));
    const binding = prior.get(key(value));
    const continuous =
      binding &&
      !binding.retired &&
      !value.evidenceAt &&
      Date.parse(at) - Date.parse(binding.observedAt) <= 600_000 &&
      JSON.stringify(binding.value.network?.addresses) ===
        JSON.stringify(value.network?.addresses) &&
      JSON.stringify(binding.value.network?.ports) === JSON.stringify(value.network?.ports);
    const history = retainBindings
      ? [
          ...(binding?.history ?? []),
          ...(binding?.value.network && binding.firstObservedAt && !continuous
            ? [
                {
                  value: binding.value,
                  firstObservedAt: binding.firstObservedAt,
                  observedAt: binding.observedAt,
                },
              ]
            : []),
        ]
          .filter((item) => Date.parse(at) - Date.parse(item.observedAt) <= 86_400_000)
          .slice(-32)
      : [];
    values.set(key(value), {
      ...(!old || observedAt >= old.observedAt ? { value, observedAt } : old),
      seenAt: at,
      ...(retainBindings ? { retired: false, history } : {}),
      ...(!value.evidenceAt
        ? { firstObservedAt: continuous ? (binding.firstObservedAt ?? at) : at }
        : {}),
    });
  }
  // A persistently partial provider must not grow an unbounded last-good inventory.
  return {
    facts: [...values.values()]
      .sort((a, b) => (b.seenAt ?? b.observedAt).localeCompare(a.seenAt ?? a.observedAt))
      .slice(0, MAX_FACTS),
    truncated: values.size > MAX_FACTS,
  };
}

function cleanStrings(value: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isSensitiveKey(key))
      .map(([key, text]) => [key, scrubSecrets(text)]),
  );
}

function boundInventory(
  entities: ObservedTopologyFact<TopologyEntity>[],
  relations: ObservedTopologyFact<TopologyRelation>[],
) {
  const keptEntities: typeof entities = [],
    keptRelations: typeof relations = [];
  let bytes = Buffer.byteLength('{"entities":[],"relations":[]}');
  let truncated = false;
  const facts = [
    ...entities.map((fact) => ({ kind: 'entity' as const, fact })),
    ...relations.map((fact) => ({ kind: 'relation' as const, fact })),
  ].sort((a, b) =>
    (b.fact.seenAt ?? b.fact.observedAt).localeCompare(a.fact.seenAt ?? a.fact.observedAt),
  );
  for (const item of facts) {
    const count = item.kind === 'entity' ? keptEntities.length : keptRelations.length;
    const size = Buffer.byteLength(JSON.stringify(item.fact)) + (count ? 1 : 0);
    if (bytes + size > MAX_INVENTORY_BYTES) {
      truncated = true;
      continue;
    }
    bytes += size;
    if (item.kind === 'entity') keptEntities.push(item.fact);
    else keptRelations.push(item.fact);
  }
  return { entities: keptEntities, relations: keptRelations, truncated };
}

/** Persist bounded observations only if the source generation and attempt are still current.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning the observations.
 * @param generation - Connector identity and settings generation captured before reading.
 * @param discovery - Inventory with per-collection completeness and read start time.
 */
export async function persistTopologyDiscovery(
  db: Db,
  tenantId: string,
  generation: { id: string; lifecycleVersion: number },
  discovery: TopologyDiscovery,
): Promise<boolean> {
  const at = new Date(discovery.observedAt);
  const persistedAt = Date.now();
  if (!Number.isFinite(at.getTime()) || at.getTime() > persistedAt + 1000)
    throw new Error('Invalid topology observation time');
  if (
    discovery.collections.length > 32 ||
    new Set(discovery.collections.map((c) => c.key)).size !== discovery.collections.length
  )
    throw new Error('Invalid topology collection keys');
  for (const c of discovery.collections) {
    for (const fact of [...c.entities, ...c.relations]) {
      if (
        fact.evidenceAt &&
        (!Number.isFinite(Date.parse(fact.evidenceAt)) || Date.parse(fact.evidenceAt) > persistedAt)
      )
        throw new Error('Invalid topology evidence time');
    }
    if (
      !c.key ||
      c.key === READER_STATUS ||
      c.entities.length + c.relations.length > MAX_FACTS ||
      new Set(c.entities.map((e) => topologyRefKey(e.ref))).size !== c.entities.length ||
      new Set(c.relations.map(topologyRelationKey)).size !== c.relations.length
    )
      throw new Error('Invalid topology inventory');
    if (
      c.scan &&
      (typeof c.scan.incomplete !== 'boolean' ||
        (c.scan.cursor !== null &&
          (typeof c.scan.cursor !== 'string' || !c.scan.cursor || c.scan.cursor.length > 4096)) ||
        (c.completeness === 'complete' && (c.scan.cursor !== null || c.scan.incomplete)))
    )
      throw new Error('Invalid topology scan');
    for (const ref of [
      ...c.entities.flatMap((e) => [e.ref, ...(e.aliases ?? [])]),
      ...c.relations.flatMap((r) => [r.from, r.to]),
    ]) {
      if (
        [ref.authority, ref.kind, ref.id].some(
          (v) => !v || v.length > 2048 || hasKnownCredential(v),
        )
      )
        throw new Error('Invalid topology reference');
    }
  }
  if (Buffer.byteLength(JSON.stringify(discovery)) > MAX_INVENTORY_BYTES)
    throw new Error('Topology inventory too large');
  return withTenant(db, tenantId, async (tx) => {
    const [source] = await tx
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, generation.id),
          eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .for('update');
    if (!source) return false;
    const previous = await tx
      .select()
      .from(topologyCollections)
      .where(eq(topologyCollections.connectorId, source.id));
    if (
      previous.some(
        (row) => row.generation === generation.lifecycleVersion && row.attemptedAt >= at,
      )
    )
      return false;
    for (const collection of [
      ...discovery.collections,
      {
        key: READER_STATUS,
        completeness: 'complete' as const,
        entities: [],
        relations: [],
        issue: undefined,
      },
    ]) {
      const old = previous.find(
        (row) => row.key === collection.key && row.generation === generation.lifecycleVersion,
      );
      const unavailable = collection.completeness === 'unavailable';
      const scan = 'scan' in collection ? collection.scan : undefined;
      if (scan && old?.scan?.incomplete && !scan.incomplete)
        throw new Error('Topology scan cannot discard an earlier gap');
      const scanStartedAt = old?.scan?.startedAt ?? at.toISOString();
      // Older checkpoints cannot distinguish unseen facts from re-read historical evidence.
      const legacyGap =
        !!scan &&
        !!old?.scan &&
        [...old.entities, ...old.relations].some(
          (fact) => !fact.seenAt && fact.observedAt < scanStartedAt,
        );
      const complete = collection.completeness === 'complete' && !legacyGap;
      const retainedSince = complete && scan ? scanStartedAt : null;
      const previousEntities = old?.entities ?? [];
      const retainedRelationsInput = old?.relations ?? [];
      const previousRelations =
        collection.key === 'logs'
          ? retainedRelationsInput.filter(
              (fact) =>
                at.getTime() - Date.parse(fact.observedAt) <= 86_400_000 &&
                logScopeAllowed(fact.value, collection.runtimeScopes ?? []),
            )
          : retainedRelationsInput;
      const entities = collection.entities.map((entity) => ({
        ...entity,
        name: scrubSecrets(entity.name),
        scope: cleanStrings(entity.scope),
        attributes: cleanStrings(entity.attributes),
      }));
      const relations = collection.relations.map((relation) => ({
        ...relation,
        description: scrubSecrets(relation.description),
        ...(relation.scope ? { scope: cleanStrings(relation.scope) } : {}),
        ...(relation.attributes ? { attributes: cleanStrings(relation.attributes) } : {}),
      }));
      const retainedEntities = mergeFacts(
        previousEntities,
        unavailable ? [] : entities,
        at.toISOString(),
        complete,
        (e) => topologyRefKey(e.ref),
        source.type === 'kubernetes',
        retainedSince,
      );
      const retainedRelations = mergeFacts(
        previousRelations,
        unavailable ? [] : relations,
        at.toISOString(),
        complete,
        topologyRelationKey,
        false,
        retainedSince,
      );
      const bounded = boundInventory(retainedEntities.facts, retainedRelations.facts);
      const limited =
        retainedEntities.truncated || retainedRelations.truncated || bounded.truncated;
      const row = {
        tenantId,
        connectorId: source.id,
        generation: generation.lifecycleVersion,
        key: collection.key,
        observedAt: unavailable && old ? old.observedAt : at,
        attemptedAt: at,
        completeness:
          (limited || legacyGap) && collection.completeness === 'complete'
            ? ('partial' as const)
            : collection.completeness,
        issue: limited ? ('limit' as const) : (collection.issue ?? null),
        entities: bounded.entities,
        relations: bounded.relations,
        scan: scan?.cursor
          ? {
              ...scan,
              incomplete: scan.incomplete || limited || legacyGap,
              startedAt: scanStartedAt,
            }
          : unavailable && old?.scan
            ? { ...old.scan, incomplete: old.scan.incomplete || limited }
            : null,
      };
      await tx
        .insert(topologyCollections)
        .values(row)
        .onConflictDoUpdate({
          target: [
            topologyCollections.tenantId,
            topologyCollections.connectorId,
            topologyCollections.key,
          ],
          set: row,
        });
    }
    return true;
  });
}

/** Read scan checkpoints only for the owning tenant's enabled, current connector generation.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning the connector.
 * @param generation - Connector identity and generation captured by the worker.
 */
export async function readTopologyScans(
  db: Db,
  tenantId: string,
  generation: { id: string; lifecycleVersion: number },
): Promise<Record<string, TopologyScanProgress>> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ key: topologyCollections.key, scan: topologyCollections.scan })
      .from(topologyCollections)
      .innerJoin(
        connectorConfigs,
        and(
          eq(connectorConfigs.tenantId, topologyCollections.tenantId),
          eq(connectorConfigs.id, topologyCollections.connectorId),
          eq(connectorConfigs.lifecycleVersion, topologyCollections.generation),
        ),
      )
      .where(
        and(
          eq(connectorConfigs.id, generation.id),
          eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      );
    return Object.fromEntries(
      rows.flatMap(({ key, scan }) =>
        scan?.cursor ? [[key, { cursor: scan.cursor, incomplete: scan.incomplete }]] : [],
      ),
    );
  });
}

/** Read attributable inventory only from enabled, current-generation connectors.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning the topology.
 */
export async function listTopologyDiscovery(db: Db, tenantId: string) {
  const rows = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        collection: topologyCollections,
        sourceName: connectorConfigs.name,
        sourceType: connectorConfigs.type,
      })
      .from(topologyCollections)
      .innerJoin(
        connectorConfigs,
        and(
          eq(connectorConfigs.tenantId, topologyCollections.tenantId),
          eq(connectorConfigs.id, topologyCollections.connectorId),
          eq(connectorConfigs.lifecycleVersion, topologyCollections.generation),
        ),
      )
      .where(and(eq(connectorConfigs.enabled, true), isNull(connectorConfigs.deletedAt))),
  );
  const scopes = runtimeScopesFromInventory(rows);
  return rows.map((row) =>
    row.sourceType === 'datadog' && row.collection.key === 'logs'
      ? {
          ...row,
          collection: {
            ...row.collection,
            relations: row.collection.relations.filter((fact) =>
              logScopeAllowed(fact.value, scopes),
            ),
          },
        }
      : row,
  );
}

function logScopeAllowed(relation: TopologyRelation, scopes: TopologyRuntimeScope[]) {
  return scopes.some(
    (scope) =>
      scope.clusterId === relation.attributes?.sourceCluster &&
      scope.namespace === relation.attributes?.sourceNamespace,
  );
}

/** Mark discovery unavailable without replacing or refreshing last-good evidence.
 * @param db - RLS-scoped application database.
 * @param tenantId - Workspace owning the connector.
 * @param generation - Connector generation captured at read start.
 * @param attemptedAt - Read start time, used to reject late failures.
 * @param issue - Sanitized provider failure category, never the provider's response body.
 */
export async function recordTopologyDiscoveryFailure(
  db: Db,
  tenantId: string,
  generation: { id: string; lifecycleVersion: number },
  attemptedAt: Date,
  issue: TopologyCollection['issue'] = 'unreachable',
) {
  return withTenant(db, tenantId, async (tx) => {
    const [source] = await tx
      .select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, generation.id),
          eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .for('update');
    if (!source) return;
    const previous = await tx
      .select({ attemptedAt: topologyCollections.attemptedAt })
      .from(topologyCollections)
      .where(
        and(
          eq(topologyCollections.connectorId, source.id),
          eq(topologyCollections.generation, generation.lifecycleVersion),
        ),
      );
    if (previous.some((row) => row.attemptedAt >= attemptedAt)) return;
    await tx
      .update(topologyCollections)
      .set({ completeness: 'unavailable', issue, attemptedAt })
      .where(
        and(
          eq(topologyCollections.connectorId, source.id),
          eq(topologyCollections.generation, generation.lifecycleVersion),
          lt(topologyCollections.attemptedAt, attemptedAt),
        ),
      );
    const status = {
      tenantId,
      connectorId: source.id,
      generation: generation.lifecycleVersion,
      key: READER_STATUS,
      observedAt: attemptedAt,
      attemptedAt,
      completeness: 'unavailable' as const,
      issue,
      entities: [],
      relations: [],
    };
    await tx
      .insert(topologyCollections)
      .values(status)
      .onConflictDoUpdate({
        target: [
          topologyCollections.tenantId,
          topologyCollections.connectorId,
          topologyCollections.key,
        ],
        set: status,
      });
  });
}
