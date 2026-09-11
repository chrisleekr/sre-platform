import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Executor } from './rls';
import { connectorConfigs, gitlabProjects } from './schema';

/**
 * Select bounded batches for both active CI and fair least-recently attempted polling.
 * @param db - Tenant-scoped application database.
 * @param tenantId - Workspace requesting the poll.
 * @param connectorId - GitLab connection owning the project catalog.
 */
export async function nextGitLabPollProjects(db: Db, tenantId: string, connectorId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const select = (preferActive: boolean) =>
      tx
        .select({
          repositoryId: gitlabProjects.projectId,
          fullName: gitlabProjects.fullPath,
          cursor: gitlabProjects.pollCursor,
        })
        .from(gitlabProjects)
        .where(and(eq(gitlabProjects.connectorId, connectorId), isNull(gitlabProjects.removedAt)))
        .orderBy(
          ...(preferActive ? [sql`${gitlabProjects.pollActive} desc`] : []),
          sql`${gitlabProjects.pollAttemptedAt} asc nulls first`,
          gitlabProjects.projectId,
        )
        .limit(2);
    const [fair, active] = await Promise.all([select(false), select(true)]);
    return [
      ...new Map([...fair, ...active].map((project) => [project.repositoryId, project])).values(),
    ];
  });
}

/**
 * Invalidate polling progress when its strategy or provider boundary changes.
 * @param db - Transaction saving the connector configuration.
 * @param tenantId - Workspace owning the connection.
 * @param connectorId - Connection whose old cursors are no longer applicable.
 * @param scopeChanged - Hide the old catalog until verification discovers the new scope.
 */
export async function resetGitLabPolling(
  db: Executor,
  tenantId: string,
  connectorId: string,
  scopeChanged: boolean,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    await tx
      .update(connectorConfigs)
      .set({ pollCursor: null })
      .where(eq(connectorConfigs.id, connectorId));
    await tx
      .update(gitlabProjects)
      .set({
        pollCursor: null,
        pollAttemptedAt: null,
        pollSucceededAt: null,
        pollFailureCategory: null,
        pollActive: false,
        ...(scopeChanged ? { removedAt: new Date() } : {}),
      })
      .where(eq(gitlabProjects.connectorId, connectorId));
  });
}

/**
 * Describe project polling coverage separately from connector and webhook health.
 * @param db - Application database enforcing tenant isolation.
 * @param tenantId - Workspace requesting connection health.
 * @param connectorId - GitLab connection whose catalog is measured.
 */
export async function gitLabPollingCoverage(db: Db, tenantId: string, connectorId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const boundary = and(
      eq(gitlabProjects.connectorId, connectorId),
      isNull(gitlabProjects.removedAt),
    );
    const streamFlag = (key: string) =>
      sql<boolean>`coalesce((${sql.join(
        ['pipeline', 'child_pipeline', 'job', 'deployment', 'release'].map(
          (stream) => sql`${gitlabProjects.pollCursor}->${stream}->>${key} = 'true'`,
        ),
        sql` or `,
      )}), false)`;
    const backlog = streamFlag('pending');
    const trackingLimited = streamFlag('activeOverflow');
    const [counts] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        notChecked: sql<number>`count(*) filter (where ${gitlabProjects.pollSucceededAt} is null)::int`,
        failed: sql<number>`count(*) filter (where ${gitlabProjects.pollFailureCategory} is not null)::int`,
        backlog: sql<number>`count(*) filter (where ${backlog})::int`,
        trackingLimited: sql<number>`count(*) filter (where ${trackingLimited})::int`,
        oldestReadAt: sql<string | null>`min(${gitlabProjects.pollSucceededAt})::text`,
        latestReadAt: sql<string | null>`max(${gitlabProjects.pollSucceededAt})::text`,
      })
      .from(gitlabProjects)
      .where(boundary);
    const projects = await tx
      .select({
        project: gitlabProjects.fullPath,
        lastAttemptAt: gitlabProjects.pollAttemptedAt,
        lastSuccessAt: gitlabProjects.pollSucceededAt,
        failureCategory: gitlabProjects.pollFailureCategory,
        backlog,
        trackingLimited,
      })
      .from(gitlabProjects)
      .where(boundary)
      .orderBy(
        sql`(${gitlabProjects.pollFailureCategory} is not null) desc`,
        sql`${gitlabProjects.pollSucceededAt} asc nulls first`,
        gitlabProjects.projectId,
      )
      .limit(8);
    return {
      ...counts!,
      oldestReadAt: counts?.oldestReadAt ? new Date(counts.oldestReadAt).toISOString() : null,
      latestReadAt: counts?.latestReadAt ? new Date(counts.latestReadAt).toISOString() : null,
      projects,
    };
  });
}
