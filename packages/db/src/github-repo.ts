import { and, desc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Executor } from './rls';
import { githubRepositories, serviceRepositories } from './schema';

export interface GitHubRepositoryInput {
  installationId: string;
  repositoryId: string;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  private: boolean;
  archived: boolean;
  htmlUrl: string;
  pushedAt?: Date;
}

export interface GitHubRepositoryMatch {
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
 * Replace the tenant's active GitHub catalog without deleting historical identities.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param installationId - installation id targeted by the operation.
 * @param repositories - GitHub repositories discovered for the connector.
 */
export async function syncGitHubRepositories(
  db: Executor,
  tenantId: string,
  connectorId: string,
  installationId: string,
  repositories: GitHubRepositoryInput[],
): Promise<number> {
  const unique = [...new Map(repositories.map((repo) => [repo.repositoryId, repo])).values()];
  await withTenant(db, tenantId, async (tx) => {
    const now = new Date();
    await tx
      .update(githubRepositories)
      .set({ removedAt: now, updatedAt: now })
      .where(
        and(eq(githubRepositories.connectorId, connectorId), isNull(githubRepositories.removedAt)),
      );
    if (unique.length === 0) return;
    await tx
      .insert(githubRepositories)
      .values(
        unique.map((repo) => ({
          tenantId,
          connectorId,
          ...repo,
          defaultBranch: repo.defaultBranch ?? null,
          pushedAt: repo.pushedAt ?? null,
          lastSyncedAt: now,
          removedAt: null,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [
          githubRepositories.tenantId,
          githubRepositories.connectorId,
          githubRepositories.repositoryId,
        ],
        targetWhere: sql`${githubRepositories.connectorId} is not null`,
        set: {
          installationId: sql`excluded.installation_id`,
          owner: sql`excluded.owner`,
          name: sql`excluded.name`,
          fullName: sql`excluded.full_name`,
          defaultBranch: sql`excluded.default_branch`,
          private: sql`excluded.private`,
          archived: sql`excluded.archived`,
          htmlUrl: sql`excluded.html_url`,
          pushedAt: sql`excluded.pushed_at`,
          lastSyncedAt: now,
          removedAt: null,
          updatedAt: now,
        },
      });
  });
  return unique.length;
}

/**
 * Upsert one repository from a verified webhook event.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param repository - Value supplied for repository.
 */
export async function upsertGitHubRepository(
  db: Executor,
  tenantId: string,
  connectorId: string,
  repository: GitHubRepositoryInput,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const now = new Date();
    await tx
      .insert(githubRepositories)
      .values({
        tenantId,
        connectorId,
        ...repository,
        defaultBranch: repository.defaultBranch ?? null,
        pushedAt: repository.pushedAt ?? null,
        lastSyncedAt: now,
        removedAt: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          githubRepositories.tenantId,
          githubRepositories.connectorId,
          githubRepositories.repositoryId,
        ],
        targetWhere: sql`${githubRepositories.connectorId} is not null`,
        set: {
          installationId: sql`excluded.installation_id`,
          owner: sql`excluded.owner`,
          name: sql`excluded.name`,
          fullName: sql`excluded.full_name`,
          defaultBranch: sql`excluded.default_branch`,
          private: sql`excluded.private`,
          archived: sql`excluded.archived`,
          htmlUrl: sql`excluded.html_url`,
          pushedAt: sql`excluded.pushed_at`,
          lastSyncedAt: now,
          removedAt: null,
          updatedAt: now,
        },
      });
  });
}

/**
 * Marks git hub repository removed.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param repositoryId - repository id targeted by the operation.
 */
export async function markGitHubRepositoryRemoved(
  db: Executor,
  tenantId: string,
  connectorId: string,
  repositoryId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(githubRepositories)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(githubRepositories.connectorId, connectorId),
          eq(githubRepositories.repositoryId, repositoryId),
        ),
      ),
  );
}

/**
 * Lists git hub repositories.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param options - Optional query or behavior controls.
 */
export async function listGitHubRepositories(
  db: Db,
  tenantId: string,
  connectorId: string,
  options: { query?: string; limit?: number; afterRepositoryId?: string } = {},
) {
  const query = options.query?.trim().toLowerCase();
  const limit = Math.min(Math.max(1, options.limit ?? 50), 100);
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        repositoryId: githubRepositories.repositoryId,
        fullName: githubRepositories.fullName,
        defaultBranch: githubRepositories.defaultBranch,
        private: githubRepositories.private,
        archived: githubRepositories.archived,
        htmlUrl: githubRepositories.htmlUrl,
        pushedAt: githubRepositories.pushedAt,
        lastSyncedAt: githubRepositories.lastSyncedAt,
      })
      .from(githubRepositories)
      .where(
        and(
          eq(githubRepositories.connectorId, connectorId),
          isNull(githubRepositories.removedAt),
          options.afterRepositoryId
            ? gt(githubRepositories.repositoryId, options.afterRepositoryId)
            : undefined,
          query ? sql`position(${query} in lower(${githubRepositories.fullName})) > 0` : undefined,
        ),
      )
      .orderBy(
        options.afterRepositoryId !== undefined
          ? githubRepositories.repositoryId
          : githubRepositories.fullName,
      )
      .limit(limit),
  );
}

/**
 * Counts git hub repositories.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 */
export async function countGitHubRepositories(
  db: Db,
  tenantId: string,
  connectorId: string,
): Promise<number> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(githubRepositories)
      .where(
        and(eq(githubRepositories.connectorId, connectorId), isNull(githubRepositories.removedAt)),
      );
    return rows[0]?.count ?? 0;
  });
}

/**
 * Disables git hub repositories.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 */
export async function deactivateGitHubRepositories(
  db: Executor,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(githubRepositories)
      .set({ removedAt: new Date(), updatedAt: new Date() })
      .where(
        and(eq(githubRepositories.connectorId, connectorId), isNull(githubRepositories.removedAt)),
      ),
  );
}

export interface ServiceRepositoryInput {
  service: string;
  provider: string;
  repositoryFullName: string;
  path?: string;
  source: string;
  confirmed?: boolean;
}

/**
 * Creates or updates service repositories.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param mappings - Value supplied for mappings.
 */
export async function upsertServiceRepositories(
  db: Executor,
  tenantId: string,
  mappings: ServiceRepositoryInput[],
): Promise<void> {
  if (mappings.length === 0) return;
  const normalized = mappings.map((mapping) => ({
    ...mapping,
    service: mapping.service.trim().toLowerCase(),
    provider: mapping.provider.trim().toLowerCase(),
    repositoryFullName: mapping.repositoryFullName.trim().toLowerCase(),
    path: mapping.path?.trim(),
  }));
  const unique = [
    ...new Map(
      normalized.map((mapping) => [
        [mapping.service, mapping.provider, mapping.repositoryFullName, mapping.path ?? ''].join(
          '\0',
        ),
        mapping,
      ]),
    ).values(),
  ];
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .insert(serviceRepositories)
      .values(
        unique.map((mapping) => ({
          tenantId,
          service: mapping.service,
          provider: mapping.provider,
          repositoryFullName: mapping.repositoryFullName,
          path: mapping.path ?? '',
          source: mapping.source,
          confirmed: mapping.confirmed ?? false,
        })),
      )
      .onConflictDoUpdate({
        target: [
          serviceRepositories.tenantId,
          serviceRepositories.service,
          serviceRepositories.provider,
          serviceRepositories.repositoryFullName,
          serviceRepositories.path,
        ],
        set: {
          source: sql`excluded.source`,
          confirmed: sql`${serviceRepositories.confirmed} or excluded.confirmed`,
          updatedAt: sql`now()`,
        },
      });
  });
}

/**
 * Resolve confirmed/discovered service mappings first, then exact repository-name matches.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param service - Service identifier used to scope the operation.
 */
export async function resolveGitHubRepositories(
  db: Db,
  tenantId: string,
  connectorId: string,
  service: string,
): Promise<GitHubRepositoryMatch[]> {
  const normalized = service.trim().toLowerCase();
  if (!normalized) return [];
  return withTenant(db, tenantId, async (tx) => {
    const mapped = await tx
      .select({
        repositoryId: githubRepositories.repositoryId,
        fullName: githubRepositories.fullName,
        defaultBranch: githubRepositories.defaultBranch,
        private: githubRepositories.private,
        archived: githubRepositories.archived,
        htmlUrl: githubRepositories.htmlUrl,
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
        githubRepositories,
        sql`lower(${serviceRepositories.repositoryFullName}) = lower(${githubRepositories.fullName})`,
      )
      .where(
        and(
          eq(serviceRepositories.provider, 'github'),
          eq(githubRepositories.connectorId, connectorId),
          sql`lower(${serviceRepositories.service}) = ${normalized}`,
          isNull(githubRepositories.removedAt),
        ),
      )
      .orderBy(desc(serviceRepositories.confirmed), githubRepositories.fullName)
      .limit(8);
    const exact = await tx
      .select({
        repositoryId: githubRepositories.repositoryId,
        fullName: githubRepositories.fullName,
        defaultBranch: githubRepositories.defaultBranch,
        private: githubRepositories.private,
        archived: githubRepositories.archived,
        htmlUrl: githubRepositories.htmlUrl,
        path: sql<string | null>`null`,
        mappingSource: sql<string | null>`null`,
        role: sql<'application_source'>`'application_source'`,
      })
      .from(githubRepositories)
      .where(
        and(
          eq(githubRepositories.connectorId, connectorId),
          isNull(githubRepositories.removedAt),
          or(
            sql`lower(${githubRepositories.name}) = ${normalized}`,
            sql`lower(${githubRepositories.fullName}) = ${normalized}`,
          ),
        ),
      )
      .orderBy(githubRepositories.fullName)
      .limit(8);
    const candidates: GitHubRepositoryMatch[] = [
      ...mapped.map((repo) => ({ ...repo, source: 'mapping' as const })),
      ...exact.map((repo) => ({ ...repo, source: 'exact_name' as const, confirmed: false })),
    ];
    const unique = new Map<string, GitHubRepositoryMatch>();
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

export * from './github-repo/events';
