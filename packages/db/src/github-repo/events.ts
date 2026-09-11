import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Executor } from '../rls';
import { githubEvents } from '../schema';

export interface GitHubEventInput {
  deliveryId: string;
  eventType: string;
  action?: string;
  repositoryId?: string;
  repositoryFullName?: string;
  actor?: string;
  ref?: string;
  sha?: string;
  summary: Record<string, unknown>;
  occurredAt: Date;
}

/**
 * Insert one verified delivery. False means GitHub redelivered an already committed event.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param event - Validated provider event to persist.
 */
export async function recordGitHubEvent(
  db: Executor,
  tenantId: string,
  connectorId: string,
  event: GitHubEventInput,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .insert(githubEvents)
      .values({ tenantId, connectorId, ...event })
      .onConflictDoNothing({
        target: [githubEvents.tenantId, githubEvents.connectorId, githubEvents.deliveryId],
        where: sql`${githubEvents.connectorId} is not null`,
      })
      .returning({ id: githubEvents.id });
    return rows.length === 1;
  });
}

/**
 * Provides recent git hub events.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorId - Connector instance targeted by the operation.
 * @param repositories - GitHub repositories discovered for the connector.
 * @param since - Lower time boundary for matching records.
 * @param limit - Maximum number of rows to return.
 */
export async function recentGitHubEvents(
  db: Db,
  tenantId: string,
  connectorId: string,
  repositories: string[],
  since: Date,
  limit = 50,
) {
  if (repositories.length === 0) return [];
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        eventType: githubEvents.eventType,
        action: githubEvents.action,
        repositoryFullName: githubEvents.repositoryFullName,
        actor: githubEvents.actor,
        ref: githubEvents.ref,
        sha: githubEvents.sha,
        summary: githubEvents.summary,
        occurredAt: githubEvents.occurredAt,
      })
      .from(githubEvents)
      .where(
        and(
          eq(githubEvents.connectorId, connectorId),
          inArray(githubEvents.repositoryFullName, repositories),
          gte(githubEvents.occurredAt, since),
        ),
      )
      .orderBy(desc(githubEvents.occurredAt))
      .limit(Math.min(Math.max(1, limit), 100)),
  );
}
