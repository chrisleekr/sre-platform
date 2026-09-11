import type {
  AffectedEntityCandidate,
  EntityKind,
  EntityMapping,
  SignalSource,
} from '@sre/contracts';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import {
  deployments,
  entityServiceMappings,
  incidentSignals,
  incidents,
  knowledgeChunks,
  serviceDependencies,
  serviceRepositories,
  services,
} from './schema';

export interface IncidentEntityObservation {
  signalId: string;
  source: SignalSource | null;
  candidates: AffectedEntityCandidate[];
}

export interface IncidentEntityServiceContext {
  name: string;
  team: string | null;
  criticality: string | null;
  dependencies: Array<{
    direction: 'upstream' | 'downstream';
    service: string;
    protocol: string | null;
  }>;
  repositories: Array<{
    provider: string;
    fullName: string;
    path: string;
    confirmed: boolean;
  }>;
  deployments: Array<{
    source: string;
    repository: string;
    revision: string;
    status: string;
    url: string | null;
    deployedAt: string;
  }>;
  runbooks: Array<{ id: string; title: string | null; source: string; verified: boolean }>;
}

export interface IncidentEntityContext {
  observations: IncidentEntityObservation[];
  mappings: EntityMapping[];
  services: IncidentEntityServiceContext[];
}

export interface EntityServiceMappingInput {
  candidateKey: string;
  candidateKind: EntityKind;
  serviceName: string;
  confirmedByUserId: string;
  rationale: string;
}

function incidentResolvesToService(serviceName: string) {
  const structuredMatch = sql`exists (
    select 1
    from ${incidentSignals}
    cross join lateral jsonb_array_elements(
      coalesce(${incidentSignals.affectedEntities}, '[]'::jsonb)
    ) as candidate
    where ${incidentSignals.incidentId} = ${incidents.id}
      and ${incidentSignals.tenantId} = ${incidents.tenantId}
      and (
        (
          candidate ->> 'kind' = 'service'
          and candidate ->> 'stableId' = ${serviceName}
          and not exists (
            select 1
            from ${entityServiceMappings}
            where ${entityServiceMappings.tenantId} = ${incidentSignals.tenantId}
              and ${entityServiceMappings.candidateKey} = candidate ->> 'key'
          )
        )
        or exists (
          select 1
          from ${entityServiceMappings}
          where ${entityServiceMappings.tenantId} = ${incidentSignals.tenantId}
            and ${entityServiceMappings.serviceName} = ${serviceName}
            and ${entityServiceMappings.candidateKey} = candidate ->> 'key'
        )
      )
  )`;
  const hasStructuredResolution = sql`exists (
    select 1
    from ${incidentSignals}
    cross join lateral jsonb_array_elements(
      coalesce(${incidentSignals.affectedEntities}, '[]'::jsonb)
    ) as candidate
    where ${incidentSignals.incidentId} = ${incidents.id}
      and ${incidentSignals.tenantId} = ${incidents.tenantId}
      and (
        exists (
          select 1
          from ${entityServiceMappings}
          where ${entityServiceMappings.tenantId} = ${incidentSignals.tenantId}
            and ${entityServiceMappings.candidateKey} = candidate ->> 'key'
        )
        or (
          candidate ->> 'kind' = 'service'
          and not exists (
            select 1
            from ${entityServiceMappings}
            where ${entityServiceMappings.tenantId} = ${incidentSignals.tenantId}
              and ${entityServiceMappings.candidateKey} = candidate ->> 'key'
          )
          and exists (
            select 1
            from ${services}
            where ${services.tenantId} = ${incidentSignals.tenantId}
              and ${services.name} = candidate ->> 'stableId'
          )
        )
      )
  )`;
  return or(
    structuredMatch,
    and(eq(incidents.service, serviceName), sql`not (${hasStructuredResolution})`),
  );
}

/**
 * Persists the tenant's human correction for one stable entity identity.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param tenantId - Tenant that owns the mapping.
 * @param input - Confirmed candidate, service, responder, and rationale.
 */
export async function upsertEntityServiceMappingTx(
  tx: Tx,
  tenantId: string,
  input: EntityServiceMappingInput,
) {
  const rows = await tx
    .insert(entityServiceMappings)
    .values({ tenantId, ...input, source: 'human' })
    .onConflictDoUpdate({
      target: [entityServiceMappings.tenantId, entityServiceMappings.candidateKey],
      set: {
        candidateKind: input.candidateKind,
        serviceName: input.serviceName,
        confirmedByUserId: input.confirmedByUserId,
        rationale: input.rationale,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return rows[0]!;
}

/**
 * Persists a tenant-scoped entity mapping correction.
 *
 * @param db - Application database connection.
 * @param tenantId - Tenant that owns the mapping.
 * @param input - Confirmed candidate, service, responder, and rationale.
 */
export function upsertEntityServiceMapping(
  db: Db,
  tenantId: string,
  input: EntityServiceMappingInput,
) {
  return withTenant(db, tenantId, (tx) => upsertEntityServiceMappingTx(tx, tenantId, input));
}

function resolvedMappings(
  candidates: AffectedEntityCandidate[],
  human: Array<typeof entityServiceMappings.$inferSelect>,
  catalog: Array<typeof services.$inferSelect>,
): EntityMapping[] {
  const humanByKey = new Map(human.map((mapping) => [mapping.candidateKey, mapping]));
  const catalogByName = new Map(catalog.map((service) => [service.name, service]));
  const mappings: EntityMapping[] = [];
  for (const candidate of candidates) {
    const correction = humanByKey.get(candidate.key);
    if (correction) {
      mappings.push({
        candidateKey: candidate.key,
        candidateKind: candidate.kind,
        serviceName: correction.serviceName,
        method: 'human',
        confirmedByUserId: correction.confirmedByUserId,
        rationale: correction.rationale,
        updatedAt: correction.updatedAt.toISOString(),
      });
      continue;
    }
    const exact = candidate.kind === 'service' ? catalogByName.get(candidate.stableId) : undefined;
    if (exact)
      mappings.push({
        candidateKey: candidate.key,
        candidateKind: candidate.kind,
        serviceName: exact.name,
        method: 'catalog_exact',
        confirmedByUserId: null,
        rationale: null,
        updatedAt: exact.updatedAt.toISOString(),
      });
  }
  return mappings.sort((left, right) => {
    if (left.method === right.method) return left.candidateKey.localeCompare(right.candidateKey);
    return left.method === 'human' ? -1 : 1;
  });
}

/**
 * Resolves typed incident entities to ownership and operational context under tenant RLS.
 *
 * @param db - Application database connection.
 * @param tenantId - Tenant that owns the incident.
 * @param incidentId - Incident whose entity context is requested.
 */
export async function resolveIncidentEntityContext(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<IncidentEntityContext | null> {
  return withTenant(db, tenantId, async (tx) => {
    const incidentRows = await tx
      .select({ id: incidents.id })
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .limit(1);
    if (!incidentRows[0]) return null;
    const signalRows = await tx
      .select({
        id: incidentSignals.id,
        source: incidentSignals.signalSource,
        candidates: incidentSignals.affectedEntities,
      })
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incidentId))
      .orderBy(incidentSignals.firstSeenAt, incidentSignals.id);
    const observations = signalRows.map((signal) => ({
      signalId: signal.id,
      source: signal.source ?? null,
      candidates: signal.candidates ?? [],
    }));
    const candidates = [
      ...new Map(
        observations
          .flatMap((observation) => observation.candidates)
          .map((item) => [item.key, item]),
      ).values(),
    ];
    const candidateKeys = candidates.map((candidate) => candidate.key);
    const [human, catalog] = await Promise.all([
      candidateKeys.length
        ? tx
            .select()
            .from(entityServiceMappings)
            .where(inArray(entityServiceMappings.candidateKey, candidateKeys))
        : Promise.resolve([]),
      tx.select().from(services).orderBy(services.name),
    ]);
    const mappings = resolvedMappings(candidates, human, catalog);
    const serviceNames = [...new Set(mappings.map((mapping) => mapping.serviceName))];
    if (serviceNames.length === 0) return { observations, mappings, services: [] };

    const [edges, repositories, serviceEvidence] = await Promise.all([
      tx
        .select()
        .from(serviceDependencies)
        .where(
          or(
            inArray(serviceDependencies.upstream, serviceNames),
            inArray(serviceDependencies.downstream, serviceNames),
          ),
        ),
      tx
        .select()
        .from(serviceRepositories)
        .where(inArray(serviceRepositories.service, serviceNames)),
      Promise.all(
        serviceNames.map(async (serviceName) => {
          const [recentDeployments, priorIncidents] = await Promise.all([
            tx
              .select()
              .from(deployments)
              .where(eq(deployments.service, serviceName))
              .orderBy(desc(deployments.deployedAt), desc(deployments.id))
              .limit(10),
            tx
              .select({ id: incidents.id })
              .from(incidents)
              .where(incidentResolvesToService(serviceName))
              .orderBy(desc(incidents.createdAt))
              .limit(100),
          ]);
          const incidentIds = priorIncidents.map((incident) => incident.id);
          const runbooks =
            incidentIds.length > 0
              ? await tx
                  .select({
                    id: knowledgeChunks.id,
                    title: knowledgeChunks.title,
                    source: knowledgeChunks.source,
                    verified: knowledgeChunks.verified,
                  })
                  .from(knowledgeChunks)
                  .where(
                    and(
                      eq(knowledgeChunks.category, 'runbook'),
                      or(
                        ...incidentIds.map(
                          (priorId) =>
                            sql`${knowledgeChunks.sourceIncidentIds} @> ${JSON.stringify([priorId])}::jsonb`,
                        ),
                      ),
                    ),
                  )
                  .orderBy(desc(knowledgeChunks.updatedAt))
                  .limit(10)
              : [];
          return { serviceName, recentDeployments, runbooks };
        }),
      ),
    ]);
    const evidenceByService = new Map(
      serviceEvidence.map((evidence) => [evidence.serviceName, evidence]),
    );
    return {
      observations,
      mappings,
      services: serviceNames.map((name) => {
        const catalogService = catalog.find((service) => service.name === name)!;
        const evidence = evidenceByService.get(name)!;
        const dependencies: IncidentEntityServiceContext['dependencies'] = [];
        for (const edge of edges) {
          if (edge.upstream === name)
            dependencies.push({
              direction: 'downstream',
              service: edge.downstream,
              protocol: edge.protocol,
            });
          else if (edge.downstream === name)
            dependencies.push({
              direction: 'upstream',
              service: edge.upstream,
              protocol: edge.protocol,
            });
        }
        return {
          name,
          team: catalogService.team,
          criticality: catalogService.criticality,
          dependencies,
          repositories: repositories
            .filter((repository) => repository.service === name)
            .map((repository) => ({
              provider: repository.provider,
              fullName: repository.repositoryFullName,
              path: repository.path,
              confirmed: repository.confirmed,
            })),
          deployments: evidence.recentDeployments.map((deployment) => ({
            source: deployment.source,
            repository: deployment.repo,
            revision: deployment.sha,
            status: deployment.status,
            url: deployment.url,
            deployedAt: deployment.deployedAt.toISOString(),
          })),
          runbooks: evidence.runbooks,
        };
      }),
    };
  });
}
