// Persist polled deploy snapshots to the `deployments` table (MR1). Called by the poll handler
// after a successful snapshot; deploy-shaped snapshots are those carrying a `sha`. A failed write
// rejects so the poller records a sanitized persistence outcome and leaves last-good cache untouched.

import {
  HIGH_RISK_BUDGET_THRESHOLD,
  persistConnectorDeployments,
  upsertServiceRepositories,
  withTenant,
  type Db,
  type NewDeploy,
  type ServiceRepositoryInput,
} from '@sre/db';
import { sloStatusForService } from '@sre/slo';
import { persistGitLabPoll } from './persist-gitlab-poll';
import {
  decodeDeploySnapshot,
  type ConnectorPollEvidence,
  type NormalizedSnapshot,
} from '@sre/connectors';

function sourceRepository(
  value: unknown,
): { provider: 'github' | 'gitlab'; fullName: string } | undefined {
  if (typeof value !== 'string') return undefined;
  const scp = value.match(/^github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  if (scp?.[1]) return { provider: 'github', fullName: scp[1] };
  const gitLabScp = value.match(/^([^@\s]+@)?([^:\s]*gitlab[^:\s]*):(.+?)(?:\.git)?\/?$/i);
  if (gitLabScp) {
    const fullName = gitLabScp[3]?.replace(/^\/+|\/+$/g, '');
    if (fullName && fullName.split('/').length >= 2) return { provider: 'gitlab', fullName };
  }
  try {
    const url = new URL(value);
    const fullName = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
    if (url.hostname.toLowerCase() === 'github.com' && /^[^/\s]+\/[^/\s]+$/.test(fullName))
      return { provider: 'github', fullName };
    if (url.hostname.toLowerCase().includes('gitlab') && fullName.split('/').length >= 2)
      return { provider: 'gitlab', fullName };
    return undefined;
  } catch {
    return undefined;
  }
}

/** Infer service-to-repository relationships from Argo CD's declared application sources. */
export function serviceRepositoriesFromSnapshots(
  snapshots: NormalizedSnapshot[],
): ServiceRepositoryInput[] {
  return snapshots.flatMap((snapshot) => {
    if (snapshot.source !== 'argocd') return [];
    const service =
      typeof snapshot.metadata.applicationName === 'string'
        ? snapshot.metadata.applicationName
        : typeof snapshot.metadata.service === 'string'
          ? snapshot.metadata.service
          : undefined;
    if (!service || !Array.isArray(snapshot.metadata.sources)) return [];
    return snapshot.metadata.sources.flatMap((raw) => {
      if (!raw || typeof raw !== 'object') return [];
      const source = raw as Record<string, unknown>;
      const repository = sourceRepository(source.repoURL);
      if (!repository) return [];
      return [
        {
          service,
          provider: repository.provider,
          repositoryFullName: repository.fullName,
          path: typeof source.path === 'string' ? source.path : undefined,
          source: 'argocd',
          confirmed: false,
        },
      ];
    });
  });
}

/** The advisory budget stamp carried on one deploy row. */
interface DeployRisk {
  budgetRemaining: number | null;
  highRisk: boolean;
}

const NO_RISK: DeployRisk = { budgetRemaining: null, highRisk: false };

/**
 * The narrowest remaining budget across a service's objectives, and whether it clears the high-risk
 * threshold. An objective awaiting its first evaluation contributes no number, so it can never be read
 * as a zero that drags the minimum down; no objective at all yields no stamp rather than a zero.
 */
async function riskForService(db: Db, tenantId: string, service: string): Promise<DeployRisk> {
  const budgets = (await sloStatusForService(db, tenantId, service))
    .map((view) => view.evaluation?.budgetRemaining)
    .filter((budget): budget is number => budget != null);
  if (budgets.length === 0) return NO_RISK;
  const budget = Math.min(...budgets);
  return { budgetRemaining: budget, highRisk: budget < HIGH_RISK_BUDGET_THRESHOLD };
}

/**
 * Resolve one budget stamp per DISTINCT service, never one per deploy row. Entirely best-effort and
 * deliberately outside the persistence transaction: this function must never reject, because a
 * rejection here would surface as `failureCategory: 'persistence'`, drop the poll's last-good cache
 * write, and turn an advisory read into a lost deploy history.
 *
 * Each service is resolved independently. The upsert writes the budget column unconditionally from
 * the incoming row, so dropping a sibling's already-resolved stamp because some other service failed
 * would silently clear that sibling's stamp. A failing service is left unstamped and the rest keep
 * theirs.
 */
async function resolveRisks(
  db: Db,
  tenantId: string,
  rows: NewDeploy[],
): Promise<Map<string, DeployRisk>> {
  const risks = new Map<string, DeployRisk>();
  const services = new Set(rows.map((row) => row.service).filter((s): s is string => !!s));
  for (const service of services) {
    try {
      risks.set(service, await riskForService(db, tenantId, service));
    } catch (err) {
      // Log ids and message only, never the raw read, then leave this one service unstamped.
      console.error(
        JSON.stringify({
          level: 'error',
          app: 'triage-worker',
          msg: 'deploy budget stamp unavailable',
          tenantId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  return risks;
}

/**
 * Persist the deploy snapshots from one poll. Deploy-shaped snapshots are those the shared decoder
 * resolves to a `sha` (error-marker/non-deploy snapshots decode to no sha and are skipped). The
 * decoder owns the fallback contract (status → 'pending', deployedAt always a valid ISO), so this path
 * no longer parses metadata itself. Persistence and cursor advancement share one transaction; failures
 * reject so the poll handler records a sanitized outcome and leaves last-good cache untouched.
 */
export async function persistDeploys(
  db: Db,
  tenantId: string,
  snapshots: NormalizedSnapshot[],
  connectorType: string | undefined = snapshots[0]?.source,
  evidence?: ConnectorPollEvidence,
  generation?: { id: string; lifecycleVersion: number },
): Promise<boolean> {
  const rows: NewDeploy[] = snapshots.flatMap((s) => {
    const d = decodeDeploySnapshot(s);
    if (!d.sha) return [];
    return [
      {
        source: d.source,
        providerId: d.providerId,
        repo: d.repo,
        ref: d.ref,
        environment: d.environment,
        transientEnvironment: d.transientEnvironment,
        actor: d.actor,
        sha: d.sha,
        revisions: d.revisions,
        operationPhase: d.operationPhase,
        service: d.service,
        status: d.status,
        url: d.url ?? null,
        deployedAt: new Date(d.deployedAt),
        providerCreatedAt: d.providerCreatedAt ? new Date(d.providerCreatedAt) : null,
        providerUpdatedAt: d.providerUpdatedAt ? new Date(d.providerUpdatedAt) : null,
      },
    ];
  });
  // Stamped BEFORE the transaction opens: the lookup is advisory and must not be able to fail the
  // write it decorates.
  const risks = await resolveRisks(db, tenantId, rows);
  for (const row of rows) {
    const risk = (row.service ? risks.get(row.service) : undefined) ?? NO_RISK;
    row.budgetRemaining = risk.budgetRemaining;
    row.highRisk = risk.highRisk;
  }
  const latestProviderUpdate = rows.reduce<number | null>((latest, row) => {
    const value = row.providerUpdatedAt?.getTime();
    return value === undefined ? latest : Math.max(latest ?? value, value);
  }, null);
  if (!connectorType) return false;
  return withTenant(db, tenantId, async (tx) => {
    const persisted = await persistConnectorDeployments(
      tx,
      tenantId,
      connectorType,
      rows,
      evidence?.cursor ??
        (latestProviderUpdate === null
          ? {}
          : { updatedAfter: new Date(latestProviderUpdate).toISOString() }),
      {
        snapshotCount: snapshots.length,
        expectedCursor: evidence?.expectedCursor,
        durationMs: evidence?.durationMs,
        rateLimitRemaining: evidence?.rateLimitRemaining,
        rateLimitResetAt: evidence?.rateLimitResetAt
          ? new Date(evidence.rateLimitResetAt)
          : undefined,
        errorCount: evidence?.errorCount,
        failureCategory: evidence?.failureCategory,
      },
      generation,
    );
    if (!persisted) return false;
    if (connectorType === 'gitlab' && generation)
      await persistGitLabPoll(tx, tenantId, generation.id, snapshots);
    await upsertServiceRepositories(tx, tenantId, serviceRepositoriesFromSnapshots(snapshots));
    return true;
  });
}
