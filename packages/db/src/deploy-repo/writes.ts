import { and, asc, desc, eq, gt, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Executor } from '../rls';
import { connectorConfigs, deployments } from '../schema';

// Persisted-deploy CRUD (MR1). Tenant scoping is by RLS (withTenant sets app.tenant_id); tenant_id
// is written on insert so the RLS WITH CHECK binds the row to the session.

// The threshold itself lives in the contracts package so the dashboard and this writer read one
// value. Re-exported here under its original name because the deploy writer imports it from this
// workspace.
export { HIGH_RISK_BUDGET_THRESHOLD } from '@sre/contracts';

/** A deploy the poller persists. (source, sha) is the idempotency key. */
export interface NewDeploy {
  source: string;
  providerId?: string | null;
  repo: string;
  ref?: string | null;
  environment?: string | null;
  transientEnvironment?: boolean;
  actor?: string | null;
  sha: string;
  revisions?: string[] | null;
  operationPhase?: string | null;
  service?: string | null;
  status: string;
  url?: string | null;
  deployedAt: Date;
  providerCreatedAt?: Date | null;
  providerUpdatedAt?: Date | null;
  /** Advisory budget stamp; optional so a writer with no objective context omits it. */
  budgetRemaining?: number | null;
  highRisk?: boolean;
}

/** One persisted deploy, as the dashboard/agent read it. */
export interface DeployRow {
  id: string;
  connectorId: string | null;
  dataSourceName: string;
  source: string;
  providerId: string | null;
  repo: string;
  ref: string | null;
  environment: string | null;
  transientEnvironment: boolean;
  actor: string | null;
  sha: string;
  revisions: string[] | null;
  operationPhase: string | null;
  service: string | null;
  status: string;
  url: string | null;
  deployedAt: Date;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  /** Narrowest remaining error budget across the service's objectives; null when unknown. */
  budgetRemaining: number | null;
  highRisk: boolean;
}

export interface DeploymentBoundary {
  current: DeployRow | null;
  previous: DeployRow | null;
  firstAfter: DeployRow | null;
}

export interface DeploymentBoundaryQuery {
  service: string;
  source: string;
  connectorId: string;
  repository: string;
  repositoryId?: string;
  at: Date;
}

const deployRowColumns = {
  id: deployments.id,
  connectorId: deployments.connectorId,
  dataSourceName: sql<string>`coalesce(${connectorConfigs.name}, 'Disconnected ' || ${deployments.source} || ' source')`,
  source: deployments.source,
  providerId: deployments.providerId,
  repo: deployments.repo,
  ref: deployments.ref,
  environment: deployments.environment,
  transientEnvironment: deployments.transientEnvironment,
  actor: deployments.actor,
  sha: deployments.sha,
  revisions: deployments.revisions,
  operationPhase: deployments.operationPhase,
  service: deployments.service,
  status: deployments.status,
  url: deployments.url,
  deployedAt: deployments.deployedAt,
  providerCreatedAt: deployments.providerCreatedAt,
  providerUpdatedAt: deployments.providerUpdatedAt,
  budgetRemaining: deployments.budgetRemaining,
  highRisk: deployments.highRisk,
} as const;

/**
 * Exact successful deployment boundary for revision selection, with no recent-history cutoff.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param query - Validated query and boundary controls.
 */
export async function deploymentBoundaryAsOf(
  db: Db,
  tenantId: string,
  query: DeploymentBoundaryQuery,
): Promise<DeploymentBoundary> {
  return withTenant(db, tenantId, async (tx) => {
    const repository = query.repository.toLowerCase().replace(/\.git$/, '');
    const repositoryId = query.repositoryId?.toLowerCase();
    const base = and(
      eq(deployments.service, query.service),
      eq(deployments.source, query.source),
      eq(deployments.connectorId, query.connectorId),
      or(
        sql`lower(regexp_replace(${deployments.repo}, '\\.git$', '')) = ${repository}`,
        repositoryId
          ? sql`lower(regexp_replace(${deployments.repo}, '\\.git$', '')) = ${repositoryId}`
          : undefined,
      ),
      sql`lower(${deployments.status}) = 'success'`,
    );
    const before = await tx
      .select(deployRowColumns)
      .from(deployments)
      .leftJoin(connectorConfigs, eq(connectorConfigs.id, deployments.connectorId))
      .where(and(base, lte(deployments.deployedAt, query.at)))
      .orderBy(desc(deployments.deployedAt), desc(deployments.id))
      .limit(2);
    const after = await tx
      .select(deployRowColumns)
      .from(deployments)
      .leftJoin(connectorConfigs, eq(connectorConfigs.id, deployments.connectorId))
      .where(and(base, gt(deployments.deployedAt, query.at)))
      .orderBy(asc(deployments.deployedAt), asc(deployments.id))
      .limit(1);
    return {
      current: before[0] ?? null,
      previous: before[1] ?? null,
      firstAfter: after[0] ?? null,
    };
  });
}

/**
 * Inserts or refreshes provider deployments using their stable provider identity.
 *
 * @param db - Database executor used for the operation.
 * @param tenantId - Tenant that owns the deployments.
 * @param rows - Normalized deployment records to persist.
 * @param connectorId - Connector instance that observed the deployments.
 */
export async function upsertDeployments(
  db: Executor,
  tenantId: string,
  rows: NewDeploy[],
  connectorId?: string,
): Promise<void> {
  if (rows.length === 0) return;
  await withTenant(db, tenantId, async (tx) => {
    const values = rows.map((r) => ({
      tenantId,
      connectorId: connectorId ?? null,
      source: r.source,
      providerId: r.providerId ?? null,
      repo: r.repo,
      ref: r.ref ?? null,
      environment: r.environment ?? null,
      transientEnvironment: r.transientEnvironment ?? false,
      actor: r.actor ?? null,
      sha: r.sha,
      revisions: r.revisions ?? null,
      operationPhase: r.operationPhase ?? null,
      service: r.service ?? null,
      status: r.status,
      url: r.url ?? null,
      deployedAt: r.deployedAt,
      providerCreatedAt: r.providerCreatedAt ?? null,
      providerUpdatedAt: r.providerUpdatedAt ?? null,
      budgetRemaining: r.budgetRemaining ?? null,
      highRisk: r.highRisk ?? false,
    }));
    const mutable = {
      status: sql`excluded.status`,
      ref: sql`excluded.ref`,
      environment: sql`excluded.environment`,
      transientEnvironment: sql`excluded.transient_environment`,
      actor: sql`excluded.actor`,
      sha: sql`excluded.sha`,
      revisions: sql`excluded.revisions`,
      operationPhase: sql`excluded.operation_phase`,
      url: sql`excluded.url`,
      deployedAt: sql`excluded.deployed_at`,
      providerCreatedAt: sql`excluded.provider_created_at`,
      providerUpdatedAt: sql`excluded.provider_updated_at`,
      service: sql`excluded.service`,
      // A re-polled deploy carries a fresher budget reading; keeping the first one would show a
      // healthy stamp long after the budget burned down.
      budgetRemaining: sql`excluded.budget_remaining`,
      highRisk: sql`excluded.high_risk`,
      updatedAt: sql`now()`,
    };
    const scoped = connectorId !== undefined;
    const argoRows = values.filter((row) => row.providerId !== null && row.source === 'argocd');
    if (argoRows.length > 0) {
      await tx
        .insert(deployments)
        .values(argoRows)
        .onConflictDoUpdate({
          target: scoped
            ? [
                deployments.tenantId,
                deployments.connectorId,
                deployments.source,
                deployments.providerId,
              ]
            : [deployments.tenantId, deployments.source, deployments.providerId],
          targetWhere: scoped
            ? sql`${deployments.connectorId} is not null and ${deployments.providerId} is not null and ${deployments.source} = 'argocd'`
            : sql`${deployments.connectorId} is null and ${deployments.providerId} is not null and ${deployments.source} = 'argocd'`,
          set: { ...mutable, repo: sql`excluded.repo` },
        });
    }
    const providerRows = values.filter((row) => row.providerId !== null && row.source !== 'argocd');
    if (providerRows.length > 0) {
      await tx
        .insert(deployments)
        .values(providerRows)
        .onConflictDoUpdate({
          target: scoped
            ? [
                deployments.tenantId,
                deployments.connectorId,
                deployments.source,
                deployments.repo,
                deployments.providerId,
              ]
            : [deployments.tenantId, deployments.source, deployments.repo, deployments.providerId],
          targetWhere: scoped
            ? sql`${deployments.connectorId} is not null and ${deployments.providerId} is not null and ${deployments.source} <> 'argocd'`
            : sql`${deployments.connectorId} is null and ${deployments.providerId} is not null and ${deployments.source} <> 'argocd'`,
          set: mutable,
        });
    }
    const legacyRows = values.filter((row) => row.providerId === null);
    if (legacyRows.length > 0) {
      await tx
        .insert(deployments)
        .values(legacyRows)
        .onConflictDoUpdate({
          target: scoped
            ? [deployments.tenantId, deployments.connectorId, deployments.source, deployments.sha]
            : [deployments.tenantId, deployments.source, deployments.sha],
          targetWhere: scoped
            ? sql`${deployments.connectorId} is not null and ${deployments.providerId} is null`
            : sql`${deployments.connectorId} is null and ${deployments.providerId} is null`,
          set: mutable,
        });
    }
  });
}

/**
 * Provides persist connector deployments.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorType - Value supplied for connector type.
 * @param rows - Normalized rows to persist.
 * @param cursor - Value supplied for cursor.
 * @param evidence - Value supplied for evidence.
 * @param generation - Connector configuration generation associated with the observation.
 */
export async function persistConnectorDeployments(
  db: Executor,
  tenantId: string,
  connectorType: string,
  rows: NewDeploy[],
  cursor: Record<string, unknown>,
  evidence: {
    /** Total polled snapshots, including resources that are not deployments. */
    snapshotCount?: number;
    expectedCursor?: Record<string, unknown>;
    durationMs?: number;
    rateLimitRemaining?: number;
    rateLimitResetAt?: Date;
    errorCount?: number;
    failureCategory?: string;
  } = {},
  generation?: { id: string; lifecycleVersion: number },
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    if (generation) {
      const current = await tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, generation.id),
            eq(connectorConfigs.type, connectorType),
            eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
            eq(connectorConfigs.enabled, true),
            ...(evidence.expectedCursor
              ? [
                  sql`coalesce(${connectorConfigs.pollCursor}, '{}'::jsonb) = ${JSON.stringify(evidence.expectedCursor)}::jsonb`,
                ]
              : []),
          ),
        )
        .for('update');
      if (current.length === 0) return false;
    }
    await upsertDeployments(tx, tenantId, rows, generation?.id);
    await tx
      .update(connectorConfigs)
      .set({
        ...(Object.keys(cursor).length > 0 ? { pollCursor: cursor } : {}),
        pollAttemptedAt: sql`now()`,
        pollSucceededAt: sql`now()`,
        pollSnapshotCount: evidence.snapshotCount ?? rows.length,
        pollErrorCount: evidence.errorCount ?? 0,
        pollFailureCategory: evidence.errorCount ? (evidence.failureCategory ?? 'partial') : null,
        pollDurationMs: evidence.durationMs,
        pollRateLimitRemaining: evidence.rateLimitRemaining,
        pollRateLimitResetAt: evidence.rateLimitResetAt,
        updatedAt: sql`now()`,
      })
      .where(
        generation
          ? and(
              eq(connectorConfigs.id, generation.id),
              eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
              eq(connectorConfigs.enabled, true),
            )
          : eq(connectorConfigs.type, connectorType),
      );
    return true;
  });
}

/**
 * Records connector poll failure.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param connectorType - Value supplied for connector type.
 * @param category - Value supplied for category.
 * @param errorCount - Value supplied for error count.
 * @param evidence - Value supplied for evidence.
 * @param generation - Connector configuration generation associated with the observation.
 */
export async function recordConnectorPollFailure(
  db: Db,
  tenantId: string,
  connectorType: string,
  category: string,
  errorCount = 1,
  evidence: {
    durationMs?: number;
    rateLimitRemaining?: number;
    rateLimitResetAt?: Date;
  } = {},
  generation?: { id: string; lifecycleVersion: number },
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        pollAttemptedAt: sql`now()`,
        pollErrorCount: errorCount,
        pollFailureCategory: category,
        pollDurationMs: evidence.durationMs,
        pollRateLimitRemaining: evidence.rateLimitRemaining,
        pollRateLimitResetAt: evidence.rateLimitResetAt,
        updatedAt: sql`now()`,
      })
      .where(
        generation
          ? and(
              eq(connectorConfigs.id, generation.id),
              eq(connectorConfigs.lifecycleVersion, generation.lifecycleVersion),
              eq(connectorConfigs.enabled, true),
            )
          : eq(connectorConfigs.type, connectorType),
      ),
  );
}

/** Options for the unified recent-deploys read. */
