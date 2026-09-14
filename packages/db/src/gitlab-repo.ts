import { and, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Executor } from './rls';
import { gitlabEvents, gitlabProjects, serviceRepositories } from './schema';

export interface GitLabProjectInput {
  groupId: string;
  projectId: string;
  name: string;
  fullPath: string;
  defaultBranch?: string;
  visibility?: string;
  archived: boolean;
  webUrl: string;
  lastActivityAt?: Date;
}

export interface GitLabProjectMatch {
  repositoryId: string;
  fullName: string;
  defaultBranch: string | null;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  path: string | null;
  mappingSource: string | null;
  source: 'mapping' | 'exact_name';
  role: 'application_source' | 'deployment_config';
  confirmed: boolean;
}

/**
 * Replace the tenant's active GitLab catalog while retaining historical identities.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param groupId - group id targeted by the operation.
 * @param projects - GitLab projects discovered for the connector.
 */
export async function syncGitLabProjects(
  db: Executor,
  tenantId: string,
  connectorId: string,
  groupId: string,
  projects: GitLabProjectInput[],
): Promise<number> {
  const unique = [...new Map(projects.map((project) => [project.projectId, project])).values()];
  await withTenant(db, tenantId, async (tx) => {
    const now = new Date();
    await tx
      .update(gitlabProjects)
      .set({ removedAt: now, updatedAt: now })
      .where(and(eq(gitlabProjects.connectorId, connectorId), isNull(gitlabProjects.removedAt)));
    if (unique.length === 0) return;
    await tx
      .insert(gitlabProjects)
      .values(
        unique.map((project) => ({
          tenantId,
          connectorId,
          ...project,
          defaultBranch: project.defaultBranch ?? null,
          visibility: project.visibility ?? null,
          lastActivityAt: project.lastActivityAt ?? null,
          lastSyncedAt: now,
          removedAt: null,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [gitlabProjects.tenantId, gitlabProjects.connectorId, gitlabProjects.projectId],
        targetWhere: sql`${gitlabProjects.connectorId} is not null`,
        set: {
          groupId: sql`excluded.group_id`,
          name: sql`excluded.name`,
          fullPath: sql`excluded.full_path`,
          defaultBranch: sql`excluded.default_branch`,
          visibility: sql`excluded.visibility`,
          archived: sql`excluded.archived`,
          webUrl: sql`excluded.web_url`,
          lastActivityAt: sql`excluded.last_activity_at`,
          lastSyncedAt: now,
          removedAt: null,
          updatedAt: now,
        },
      });
  });
  return unique.length;
}

/**
 * Counts git lab projects.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 */
export async function countGitLabProjects(
  db: Db,
  tenantId: string,
  connectorId: string,
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(gitlabProjects)
      .where(and(eq(gitlabProjects.connectorId, connectorId), isNull(gitlabProjects.removedAt)));
    return rows[0]?.count ?? 0;
  });
}

/**
 * Disables git lab projects.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 */
export async function deactivateGitLabProjects(
  db: Executor,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(gitlabProjects)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(gitlabProjects.connectorId, connectorId), isNull(gitlabProjects.removedAt))),
  );
}

/**
 * Creates or updates git lab project.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param project - Value supplied for project.
 * @param observedAt - Poll start time, preventing an older catalog read from replacing a newer webhook update.
 */
export async function upsertGitLabProject(
  db: Executor,
  tenantId: string,
  connectorId: string,
  project: GitLabProjectInput,
  observedAt?: Date,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const now = new Date();
    await tx
      .insert(gitlabProjects)
      .values({
        tenantId,
        connectorId,
        ...project,
        defaultBranch: project.defaultBranch ?? null,
        visibility: project.visibility ?? null,
        lastActivityAt: project.lastActivityAt ?? null,
        lastSyncedAt: observedAt ?? now,
        removedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [gitlabProjects.tenantId, gitlabProjects.connectorId, gitlabProjects.projectId],
        targetWhere: sql`${gitlabProjects.connectorId} is not null`,
        set: {
          groupId: sql`excluded.group_id`,
          name: sql`excluded.name`,
          fullPath: sql`excluded.full_path`,
          defaultBranch: sql`coalesce(excluded.default_branch, ${gitlabProjects.defaultBranch})`,
          visibility: sql`coalesce(excluded.visibility, ${gitlabProjects.visibility})`,
          archived: sql`excluded.archived`,
          webUrl: sql`excluded.web_url`,
          lastActivityAt: sql`coalesce(excluded.last_activity_at, ${gitlabProjects.lastActivityAt})`,
          lastSyncedAt: observedAt ?? now,
          removedAt: null,
          updatedAt: now,
        },
        setWhere: observedAt
          ? sql`${gitlabProjects.lastSyncedAt} <= ${observedAt.toISOString()}::timestamptz`
          : undefined,
      });
  });
}

/**
 * Marks git lab project removed.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param projectId - project id targeted by the operation.
 */
export async function markGitLabProjectRemoved(
  db: Executor,
  tenantId: string,
  connectorId: string,
  projectId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(gitlabProjects)
      .set({ removedAt: new Date(), updatedAt: new Date(), lastSyncedAt: new Date() })
      .where(
        and(eq(gitlabProjects.connectorId, connectorId), eq(gitlabProjects.projectId, projectId)),
      ),
  );
}

/**
 * Lists git lab projects.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param options - Optional query or behavior controls.
 */
export async function listGitLabProjects(
  db: Db,
  tenantId: string,
  connectorId: string,
  options: { query?: string; limit?: number; afterRepositoryId?: string } = {},
) {
  const normalized = options.query?.trim().toLowerCase();
  const query = normalized === '*' ? '' : normalized;
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        repositoryId: gitlabProjects.projectId,
        fullName: gitlabProjects.fullPath,
        defaultBranch: gitlabProjects.defaultBranch,
        private: sql<boolean>`${gitlabProjects.visibility} = 'private'`,
        archived: gitlabProjects.archived,
        htmlUrl: gitlabProjects.webUrl,
        lastActivityAt: gitlabProjects.lastActivityAt,
        lastSyncedAt: gitlabProjects.lastSyncedAt,
      })
      .from(gitlabProjects)
      .where(
        and(
          eq(gitlabProjects.connectorId, connectorId),
          isNull(gitlabProjects.removedAt),
          options.afterRepositoryId
            ? gt(gitlabProjects.projectId, options.afterRepositoryId)
            : undefined,
          query
            ? or(
                eq(gitlabProjects.projectId, query),
                sql`position(${query} in lower(${gitlabProjects.fullPath})) > 0`,
              )
            : undefined,
        ),
      )
      .orderBy(
        ...(query && options.afterRepositoryId === undefined
          ? [
              sql`case when ${gitlabProjects.projectId} = ${query} then 0 when lower(${gitlabProjects.fullPath}) = ${query} then 1 else 2 end`,
            ]
          : []),
        options.afterRepositoryId !== undefined
          ? gitlabProjects.projectId
          : gitlabProjects.fullPath,
      )
      .limit(limit),
  );
}

/**
 * Resolves git lab projects.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param service - Service identifier used to scope the operation.
 */
export async function resolveGitLabProjects(
  db: Db,
  tenantId: string,
  connectorId: string,
  service: string,
): Promise<GitLabProjectMatch[]> {
  const normalized = service.trim().toLowerCase();
  if (!normalized) return [];
  return withTenant(db, tenantId, async (tx) => {
    const mapped = await tx
      .select({
        repositoryId: gitlabProjects.projectId,
        fullName: gitlabProjects.fullPath,
        defaultBranch: gitlabProjects.defaultBranch,
        private: sql<boolean>`${gitlabProjects.visibility} = 'private'`,
        archived: gitlabProjects.archived,
        htmlUrl: gitlabProjects.webUrl,
        path: serviceRepositories.path,
        mappingSource: serviceRepositories.source,
        role: sql<'application_source' | 'deployment_config'>`case
          when ${serviceRepositories.source} = 'argocd' then 'deployment_config'
          else 'application_source'
        end`,
        confirmed: serviceRepositories.confirmed,
      })
      .from(serviceRepositories)
      .innerJoin(
        gitlabProjects,
        sql`lower(${serviceRepositories.repositoryFullName}) = lower(${gitlabProjects.fullPath})`,
      )
      .where(
        and(
          eq(serviceRepositories.provider, 'gitlab'),
          eq(gitlabProjects.connectorId, connectorId),
          sql`lower(${serviceRepositories.service}) = ${normalized}`,
          isNull(gitlabProjects.removedAt),
        ),
      )
      .orderBy(desc(serviceRepositories.confirmed), gitlabProjects.fullPath)
      .limit(8);
    const exact = await tx
      .select({
        repositoryId: gitlabProjects.projectId,
        fullName: gitlabProjects.fullPath,
        defaultBranch: gitlabProjects.defaultBranch,
        private: sql<boolean>`${gitlabProjects.visibility} = 'private'`,
        archived: gitlabProjects.archived,
        htmlUrl: gitlabProjects.webUrl,
        path: sql<string | null>`null`,
        mappingSource: sql<string | null>`null`,
        role: sql<'application_source'>`'application_source'`,
      })
      .from(gitlabProjects)
      .where(
        and(
          eq(gitlabProjects.connectorId, connectorId),
          isNull(gitlabProjects.removedAt),
          or(
            sql`lower(${gitlabProjects.name}) = ${normalized}`,
            sql`lower(${gitlabProjects.fullPath}) = ${normalized}`,
          ),
        ),
      )
      .orderBy(gitlabProjects.fullPath)
      .limit(8);
    const candidates: GitLabProjectMatch[] = [
      ...mapped.map((project) => ({ ...project, source: 'mapping' as const })),
      ...exact.map((project) => ({
        ...project,
        source: 'exact_name' as const,
        confirmed: false,
      })),
    ];
    const unique = new Map<string, GitLabProjectMatch>();
    for (const candidate of candidates)
      if (!unique.has(candidate.repositoryId)) unique.set(candidate.repositoryId, candidate);
    return [...unique.values()]
      .sort(
        (a, b) =>
          Number(b.role === 'application_source') - Number(a.role === 'application_source') ||
          Number(b.confirmed) - Number(a.confirmed) ||
          Number(b.source === 'mapping') - Number(a.source === 'mapping') ||
          a.fullName.localeCompare(b.fullName),
      )
      .slice(0, 8);
  });
}

export interface GitLabEventInput {
  deliveryId: string;
  observationKey?: string;
  eventType: string;
  action?: string;
  projectId?: string;
  projectFullPath?: string;
  actor?: string;
  ref?: string;
  sha?: string;
  summary: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Records git lab event.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param event - Validated provider event to persist.
 */
export async function recordGitLabEvent(
  db: Executor,
  tenantId: string,
  connectorId: string,
  event: GitLabEventInput,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(gitlabEvents)
      .values({ tenantId, connectorId, ...event, receivedAt: sql`clock_timestamp()` })
      .onConflictDoNothing({
        target: [gitlabEvents.tenantId, gitlabEvents.connectorId, gitlabEvents.deliveryId],
        where: sql`${gitlabEvents.connectorId} is not null`,
      })
      .returning({ id: gitlabEvents.id });
    return rows.length === 1;
  });
}

/**
 * Provides recent git lab events.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param projects - GitLab projects discovered for the connector.
 * @param since - Lower time boundary for matching records.
 * @param limit - Maximum number of rows to return.
 */
export async function recentGitLabEvents(
  db: Db,
  tenantId: string,
  connectorId: string,
  projects: string[],
  since: Date,
  limit = 50,
) {
  if (projects.length === 0) return [];
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        eventType: gitlabEvents.eventType,
        action: gitlabEvents.action,
        repositoryFullName: gitlabEvents.projectFullPath,
        actor: gitlabEvents.actor,
        ref: gitlabEvents.ref,
        sha: gitlabEvents.sha,
        summary: gitlabEvents.summary,
        occurredAt: gitlabEvents.occurredAt,
      })
      .from(gitlabEvents)
      .where(
        and(
          eq(gitlabEvents.connectorId, connectorId),
          inArray(gitlabEvents.projectFullPath, projects),
          gte(gitlabEvents.occurredAt, since),
          sql`(${gitlabEvents.observationKey} is null or not exists (
            select 1 from gitlab_events prior
            where prior.tenant_id = ${gitlabEvents.tenantId}
              and prior.connector_id = ${gitlabEvents.connectorId}
              and prior.observation_key = ${gitlabEvents.observationKey}
              and (prior.received_at, prior.id) < (${gitlabEvents.receivedAt}, ${gitlabEvents.id})
          ))`,
        ),
      )
      .orderBy(desc(gitlabEvents.occurredAt))
      .limit(Math.min(Math.max(1, limit), 100)),
  );
}
