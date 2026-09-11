import type {
  AutomaticInvestigationBudgetLimits,
  InvestigationBudgetExhaustion,
  InvestigationBudgetScopeSnapshot,
  InvestigationBudgetSnapshot,
  InvestigationMonitorBudgetSnapshot,
  InvestigationOperation,
  InvestigationRunOutcome,
  InvestigationTrigger,
} from '@sre/contracts';
import { and, eq, exists, gte, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant, type Tx } from './rls';
import { investigationRuns, llmInvocations } from './schema';
import { investigationMonitorKeys } from './investigation-trigger';
import {
  existingJobAdmissionTx,
  hasPendingIncidentRunTx,
  supersedePendingRunsTx,
} from './investigation-run-state';
import { filterIncidentEvidenceIdsTx } from './tool-call-repo';
export interface BeginInvestigationRunInput {
  operation: InvestigationOperation;
  turnBudget?: number;
}
export interface AdmitInvestigationRunInput extends BeginInvestigationRunInput {
  jobId: string;
  trigger: InvestigationTrigger;
  limits: AutomaticInvestigationBudgetLimits;
}
export interface InvestigationRunAdmission {
  id: string;
  admitted: boolean;
  budget: InvestigationBudgetSnapshot | null;
}
export interface CompleteInvestigationRunInput {
  id: string;
  provider: string | null;
  engineModel: string | null;
  engineSessionId: string | null;
  turnBudget: number;
  outcome: InvestigationRunOutcome;
  result: Record<string, unknown>;
  evidenceIds: string[];
}

async function automaticRunCountTx(tx: Tx, tenantId: string): Promise<number> {
  const rows = await tx
    .select({ count: sql<string>`count(*)` })
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.tenantId, tenantId),
        eq(investigationRuns.triggerAutomatic, true),
        eq(investigationRuns.admissionDenied, false),
        gte(investigationRuns.startedAt, sql<Date>`now() - interval '24 hours'`),
      ),
    );
  return Number.parseInt(rows[0]?.count ?? '0', 10) || 0;
}

async function automaticConfiguredCostTx(tx: Tx, tenantId: string): Promise<number> {
  const runExists = tx
    .select({ one: sql`1` })
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.tenantId, llmInvocations.tenantId),
        eq(investigationRuns.jobId, llmInvocations.jobId),
        eq(investigationRuns.triggerAutomatic, true),
        eq(investigationRuns.admissionDenied, false),
      ),
    );
  const rows = await tx
    .select({ cost: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)` })
    .from(llmInvocations)
    .where(
      and(
        eq(llmInvocations.tenantId, tenantId),
        gte(llmInvocations.startedAt, sql<Date>`now() - interval '24 hours'`),
        exists(runExists),
      ),
    );
  return Number(rows[0]?.cost ?? 0) || 0;
}

async function automaticCostStateTx(
  tx: Tx,
  tenantId: string,
): Promise<{ pending: number; missing: number; unpriced: number }> {
  const unpricedInvocation = tx
    .select({ one: sql`1` })
    .from(llmInvocations)
    .where(
      and(
        eq(llmInvocations.tenantId, investigationRuns.tenantId),
        eq(llmInvocations.jobId, investigationRuns.jobId),
        eq(llmInvocations.usageReported, true),
        isNull(llmInvocations.configuredCostUsd),
      ),
    );
  const missingUsageInvocation = tx
    .select({ one: sql`1` })
    .from(llmInvocations)
    .where(
      and(
        eq(llmInvocations.tenantId, investigationRuns.tenantId),
        eq(llmInvocations.jobId, investigationRuns.jobId),
        eq(llmInvocations.usageReported, false),
      ),
    );
  const rows = await tx
    .select({
      pending: sql<string>`count(*) filter (where ${investigationRuns.completedAt} is null)`,
      missing: sql<string>`count(*) filter (where ${investigationRuns.completedAt} is not null and ${exists(missingUsageInvocation)})`,
      unpriced: sql<string>`count(*) filter (where ${investigationRuns.completedAt} is not null and ${exists(unpricedInvocation)})`,
    })
    .from(investigationRuns)
    .where(
      and(
        eq(investigationRuns.tenantId, tenantId),
        eq(investigationRuns.triggerAutomatic, true),
        eq(investigationRuns.admissionDenied, false),
        gte(investigationRuns.startedAt, sql<Date>`now() - interval '24 hours'`),
      ),
    );
  return {
    pending: Number.parseInt(rows[0]?.pending ?? '0', 10) || 0,
    missing: Number.parseInt(rows[0]?.missing ?? '0', 10) || 0,
    unpriced: Number.parseInt(rows[0]?.unpriced ?? '0', 10) || 0,
  };
}

interface MonitorBudgetRow extends Record<string, unknown> {
  monitorKey: string;
  runs: string;
  configuredCostUsd: string;
  pendingCostRuns: string;
  missingUsageRuns: string;
  unpricedRuns: string;
}

async function automaticMonitorBudgetScopesTx(
  tx: Tx,
  tenantId: string,
  monitorKeys: string[],
  limits: AutomaticInvestigationBudgetLimits,
): Promise<InvestigationMonitorBudgetSnapshot[]> {
  if (monitorKeys.length === 0) return [];
  const requested = sql.join(
    monitorKeys.map((monitorKey) => sql`(${monitorKey})`),
    sql`, `,
  );
  const result = await tx.execute<MonitorBudgetRow>(sql`
    with requested(monitor_key) as (
      values ${requested}
    ), recent_runs as (
      select runs.id, runs.job_id, runs.completed_at, requested.monitor_key
      from requested
      join investigation_runs runs
        on requested.monitor_key = any(runs.trigger_monitor_keys)
      where runs.tenant_id = ${tenantId}
        and runs.trigger_automatic = true
        and runs.admission_denied = false
        and runs.started_at >= now() - interval '24 hours'
    ), run_stats as (
      select
        recent_runs.monitor_key,
        count(*) as runs,
        count(*) filter (where recent_runs.completed_at is null) as pending_cost_runs,
        count(*) filter (
          where recent_runs.completed_at is not null
            and exists (
              select 1
              from llm_invocations invocations
              where invocations.tenant_id = ${tenantId}
                and invocations.job_id = recent_runs.job_id
                and invocations.usage_reported = false
            )
        ) as missing_usage_runs,
        count(*) filter (
          where recent_runs.completed_at is not null
            and exists (
              select 1
              from llm_invocations invocations
              where invocations.tenant_id = ${tenantId}
                and invocations.job_id = recent_runs.job_id
                and invocations.usage_reported = true
                and invocations.configured_cost_usd is null
            )
        ) as unpriced_runs
      from recent_runs
      group by recent_runs.monitor_key
    ), recent_costs as (
      select distinct
        requested.monitor_key,
        invocations.id,
        invocations.configured_cost_usd
      from requested
      join investigation_runs runs
        on requested.monitor_key = any(runs.trigger_monitor_keys)
      join llm_invocations invocations
        on invocations.tenant_id = runs.tenant_id
       and invocations.job_id = runs.job_id
      where runs.tenant_id = ${tenantId}
        and runs.trigger_automatic = true
        and runs.admission_denied = false
        and invocations.started_at >= now() - interval '24 hours'
    ), cost_stats as (
      select
        recent_costs.monitor_key,
        coalesce(sum(recent_costs.configured_cost_usd), 0) as configured_cost_usd
      from recent_costs
      group by recent_costs.monitor_key
    )
    select
      requested.monitor_key as "monitorKey",
      coalesce(run_stats.runs, 0) as runs,
      coalesce(cost_stats.configured_cost_usd, 0) as "configuredCostUsd",
      coalesce(run_stats.pending_cost_runs, 0) as "pendingCostRuns",
      coalesce(run_stats.missing_usage_runs, 0) as "missingUsageRuns",
      coalesce(run_stats.unpriced_runs, 0) as "unpricedRuns"
    from requested
    left join run_stats using (monitor_key)
    left join cost_stats using (monitor_key)
    order by requested.monitor_key
  `);
  return [...result].map((row) => ({
    monitorKey: row.monitorKey,
    runs: Number.parseInt(row.runs, 10) || 0,
    configuredCostUsd: Number(row.configuredCostUsd) || 0,
    pendingCostRuns: Number.parseInt(row.pendingCostRuns, 10) || 0,
    missingUsageRuns: Number.parseInt(row.missingUsageRuns, 10) || 0,
    unpricedRuns: Number.parseInt(row.unpricedRuns, 10) || 0,
    runLimit: limits.monitorRunLimit,
    configuredCostLimitUsd: limits.monitorConfiguredCostLimitUsd,
  }));
}

function exceeded(value: number, limit: number): boolean {
  return limit > 0 && value >= limit;
}

async function automaticBudgetSnapshotTx(
  tx: Tx,
  tenantId: string,
  monitorKeys: string[],
  limits: AutomaticInvestigationBudgetLimits,
): Promise<InvestigationBudgetSnapshot> {
  const tenantScope = async (): Promise<InvestigationBudgetScopeSnapshot> => {
    const [runs, configuredCostUsd, costState] = await Promise.all([
      automaticRunCountTx(tx, tenantId),
      automaticConfiguredCostTx(tx, tenantId),
      automaticCostStateTx(tx, tenantId),
    ]);
    return {
      runs,
      configuredCostUsd,
      pendingCostRuns: costState.pending,
      missingUsageRuns: costState.missing,
      unpricedRuns: costState.unpriced,
      runLimit: limits.tenantRunLimit,
      configuredCostLimitUsd: limits.tenantConfiguredCostLimitUsd,
    };
  };
  const [tenant, monitors] = await Promise.all([
    tenantScope(),
    automaticMonitorBudgetScopesTx(tx, tenantId, monitorKeys, limits),
  ]);
  const exhaustedBy: InvestigationBudgetExhaustion[] = [];
  if (
    !limits.configuredCostReady &&
    (limits.tenantConfiguredCostLimitUsd > 0 || limits.monitorConfiguredCostLimitUsd > 0)
  )
    exhaustedBy.push('configured_cost_unavailable');
  if (exceeded(tenant.runs, tenant.runLimit)) exhaustedBy.push('tenant_run_limit');
  if (monitors.some((monitor) => exceeded(monitor.runs, monitor.runLimit)))
    exhaustedBy.push('monitor_run_limit');
  if (exceeded(tenant.configuredCostUsd, tenant.configuredCostLimitUsd))
    exhaustedBy.push('tenant_configured_cost_limit');
  if (
    monitors.some((monitor) => exceeded(monitor.configuredCostUsd, monitor.configuredCostLimitUsd))
  )
    exhaustedBy.push('monitor_configured_cost_limit');
  if (tenant.configuredCostLimitUsd > 0 && tenant.pendingCostRuns > 0)
    exhaustedBy.push('tenant_configured_cost_pending');
  if (monitors.some((monitor) => monitor.configuredCostLimitUsd > 0 && monitor.pendingCostRuns > 0))
    exhaustedBy.push('monitor_configured_cost_pending');
  if (tenant.configuredCostLimitUsd > 0 && tenant.missingUsageRuns > 0)
    exhaustedBy.push('tenant_missing_usage');
  if (
    monitors.some((monitor) => monitor.configuredCostLimitUsd > 0 && monitor.missingUsageRuns > 0)
  )
    exhaustedBy.push('monitor_missing_usage');
  if (tenant.configuredCostLimitUsd > 0 && tenant.unpricedRuns > 0)
    exhaustedBy.push('tenant_unpriced_usage');
  if (monitors.some((monitor) => monitor.configuredCostLimitUsd > 0 && monitor.unpricedRuns > 0))
    exhaustedBy.push('monitor_unpriced_usage');
  return { windowHours: 24, tenant, monitors, exhaustedBy };
}

/**
 * Reads the rolling automatic budget that would govern this incident's next run.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose rolling usage is read.
 * @param incidentId - Incident checked for an active run.
 * @param monitorKeys - Provider monitor identities affected by the incident.
 * @param limits - Current automatic-investigation policy limits.
 */
export async function readAutomaticInvestigationBudget(
  db: Db,
  tenantId: string,
  incidentId: string,
  monitorKeys: string[],
  limits: AutomaticInvestigationBudgetLimits,
): Promise<InvestigationBudgetSnapshot> {
  return withTenant(db, tenantId, async (tx) => {
    const normalized = investigationMonitorKeys(monitorKeys);
    const budget = await automaticBudgetSnapshotTx(tx, tenantId, normalized, limits);
    if (await hasPendingIncidentRunTx(tx, incidentId))
      budget.exhaustedBy.unshift('incident_run_pending');
    return budget;
  });
}

/**
 * Starts one immutable investigation attempt before engine execution.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the run.
 * @param incidentId - Incident being investigated.
 * @param input - Run operation and initial turn budget.
 */
export async function beginInvestigationRun(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: BeginInvestigationRunInput,
): Promise<string> {
  return withTenant(db, tenantId, async (tx) => {
    await supersedePendingRunsTx(tx, incidentId);
    const [row] = await tx
      .insert(investigationRuns)
      .values({
        tenantId,
        incidentId,
        operation: input.operation,
        turnBudget: input.turnBudget ?? 0,
      })
      .returning({ id: investigationRuns.id });
    if (!row) throw new Error('investigation run insert failed');
    return row.id;
  });
}

/**
 * Starts a paid run only when its rolling automatic budget permits it.
 *
 * @param tx - Existing tenant-scoped admission transaction.
 * @param tenantId - Tenant that owns the run and rolling counters.
 * @param incidentId - Incident being investigated.
 * @param input - Job provenance, automatic budget limits, and run operation.
 */
export async function admitInvestigationRunTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  input: AdmitInvestigationRunInput,
): Promise<InvestigationRunAdmission> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
  const existing = await existingJobAdmissionTx(
    tx,
    tenantId,
    incidentId,
    input.jobId,
    input.operation,
  );
  if (existing) return existing;
  const monitorKeys = input.trigger.automatic
    ? investigationMonitorKeys(input.trigger.monitorKeys ?? [input.trigger.monitorKey])
    : [];
  const budget = input.trigger.automatic
    ? await automaticBudgetSnapshotTx(tx, tenantId, monitorKeys, input.limits)
    : null;
  if (budget && (await hasPendingIncidentRunTx(tx, incidentId)))
    budget.exhaustedBy.unshift('incident_run_pending');
  const admitted = !budget || budget.exhaustedBy.length === 0;
  if (admitted && !input.trigger.automatic) await supersedePendingRunsTx(tx, incidentId);
  const rows = await tx
    .insert(investigationRuns)
    .values({
      tenantId,
      incidentId,
      jobId: input.jobId,
      operation: input.operation,
      triggerReason: input.trigger.reason,
      triggerAutomatic: input.trigger.automatic,
      triggerMonitorKey: monitorKeys.length === 1 ? monitorKeys[0]! : null,
      triggerMonitorKeys: monitorKeys,
      triggerBudget: budget,
      admissionDenied: !admitted,
      turnBudget: admitted ? (input.turnBudget ?? 0) : 0,
      ...(admitted
        ? {}
        : {
            outcome: 'budget_exhausted' as const,
            result: {
              summary:
                'Automatic investigation budget exhausted. A responder message can continue the investigation.',
              exhaustedBy: budget!.exhaustedBy,
            },
            completedAt: sql`now()`,
          }),
    })
    .returning({ id: investigationRuns.id });
  const id = rows[0]?.id;
  if (!id) throw new Error('investigation run insert failed');
  return { id, admitted, budget };
}

/**
 * Starts a paid run only when its rolling automatic budget permits it.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the run and rolling counters.
 * @param incidentId - Incident being investigated.
 * @param input - Job provenance, automatic budget limits, and run operation.
 */
export async function admitInvestigationRun(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: AdmitInvestigationRunInput,
): Promise<InvestigationRunAdmission> {
  return withTenant(db, tenantId, (tx) => admitInvestigationRunTx(tx, tenantId, incidentId, input));
}

/**
 * Completes a run once and filters its evidence links to the owning incident.
 *
 * @param tx - Tenant-scoped transaction used for the completion.
 * @param incidentId - Incident that owns the run and evidence.
 * @param input - Terminal run metadata and result.
 */
export async function completeInvestigationRunTx(
  tx: Tx,
  incidentId: string,
  input: CompleteInvestigationRunInput,
) {
  const evidenceIds = await filterIncidentEvidenceIdsTx(tx, incidentId, input.evidenceIds);
  const [completed] = await tx
    .update(investigationRuns)
    .set({
      provider: input.provider,
      engineModel: input.engineModel,
      engineSessionId: input.engineSessionId,
      turnBudget: input.turnBudget,
      outcome: input.outcome,
      result: input.result,
      evidenceIds,
      completedAt: sql`now()`,
    })
    .where(
      and(
        eq(investigationRuns.id, input.id),
        eq(investigationRuns.incidentId, incidentId),
        isNull(investigationRuns.completedAt),
      ),
    )
    .returning({ id: investigationRuns.id, evidenceIds: investigationRuns.evidenceIds });
  return completed ?? null;
}

/**
 * Completes a non-promoting run in a tenant-scoped transaction.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the run.
 * @param incidentId - Incident that owns the run and evidence.
 * @param input - Terminal run metadata and result.
 */
export async function completeInvestigationRun(
  db: Db,
  tenantId: string,
  incidentId: string,
  input: CompleteInvestigationRunInput,
) {
  return withTenant(db, tenantId, (tx) => completeInvestigationRunTx(tx, incidentId, input));
}
