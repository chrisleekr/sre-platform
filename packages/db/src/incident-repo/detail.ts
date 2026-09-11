import type {
  InvestigationBudgetSnapshot,
  InvestigationGap,
  InvestigationOperation,
  InvestigationRunOutcome,
  InvestigationTriggerReason,
} from '@sre/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Tx } from '../rls';
import {
  approvals,
  inboundChannels,
  incidentSignals,
  incidents,
  investigationRuns,
  jobs,
  surfaceBindings,
  type IncidentStatus,
  type RankedHypothesisRecord,
} from '../schema';

export interface LatestInvestigationRun {
  id: string;
  operation: InvestigationOperation;
  outcome: InvestigationRunOutcome;
  triggerReason: InvestigationTriggerReason | null;
  triggerAutomatic: boolean;
  triggerMonitorKey: string | null;
  triggerMonitorKeys: string[];
  triggerBudget: InvestigationBudgetSnapshot | null;
  summary: string | null;
  nextStep: string | null;
  reason: string | null;
  completedAt: string;
}

export interface PendingIncidentAutomation {
  type: string;
  status: 'queued' | 'processing';
  scheduledAt: string;
}

const latestInvestigationRunSql = () => sql<LatestInvestigationRun | null>`(
  select jsonb_build_object(
    'id', ${investigationRuns.id},
    'operation', ${investigationRuns.operation},
    'outcome', ${investigationRuns.outcome},
    'triggerReason', ${investigationRuns.triggerReason},
    'triggerAutomatic', ${investigationRuns.triggerAutomatic},
    'triggerMonitorKey', ${investigationRuns.triggerMonitorKey},
    'triggerMonitorKeys', ${investigationRuns.triggerMonitorKeys},
    'triggerBudget', ${investigationRuns.triggerBudget},
    'summary', ${investigationRuns.result} ->> 'summary',
    'nextStep', ${investigationRuns.result} ->> 'nextStep',
    'reason', ${investigationRuns.result} ->> 'reason',
    'completedAt', to_char(
      ${investigationRuns.completedAt} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  from ${investigationRuns}
  where ${investigationRuns.tenantId} = ${sql`${incidents.tenantId}`}
    and ${investigationRuns.incidentId} = ${sql`${incidents.id}`}
    and ${investigationRuns.completedAt} is not null
    and not (
      ${investigationRuns.outcome} = 'failed'
      and ${investigationRuns.result} ->> 'reason' = 'superseded_pending_run'
    )
  order by ${investigationRuns.startedAt} desc, ${investigationRuns.id} desc
  limit 1
)`;

const pendingIncidentAutomationSql = (
  queuedResponderOnly = false,
) => sql<PendingIncidentAutomation | null>`(
  select jsonb_build_object(
    'type', ${jobs.type},
    'status', ${jobs.status},
    'scheduledAt', to_char(
      ${jobs.availableAt} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    )
  )
  from ${jobs}
  where ${jobs.tenantId} = ${sql`${incidents.tenantId}`}
    and ${jobs.payload} ->> 'incidentId' = ${sql`${incidents.id}`}::text
    and ${jobs.status} in ('queued', 'processing')
    and ${jobs.type} in ('triage', 'signal.reassess', 'resume', 'recovery.verify')
    and ${queuedResponderOnly ? sql`${jobs.type} = 'resume' and ${jobs.status} = 'queued'` : sql`true`}
  order by case when ${jobs.status} = 'processing' then 0 else 1 end,
    ${jobs.availableAt}, ${jobs.createdAt}, ${jobs.id}
  limit 1
)`;

/**
 * Returns incident lifecycle tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param id - Value supplied for id.
 */
export async function getIncidentLifecycleTx(
  tx: Tx,
  id: string,
): Promise<{ status: IncidentStatus; version: number } | null> {
  const rows = await tx
    .select({ status: incidents.status, version: incidents.lifecycleVersion })
    .from(incidents)
    .where(eq(incidents.id, id))
    .limit(1);
  return rows[0] ? { status: rows[0].status as IncidentStatus, version: rows[0].version } : null;
}

/**
 * Returns incident.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 */
export async function getIncident(db: Db, tenantId: string, id: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx.select().from(incidents).where(eq(incidents.id, id));
    return rows[0] ?? null;
  });
}

export interface IncidentSummary {
  purpose?: 'incident' | 'health_check';
  id: string;
  service: string;
  severity: string;
  status: string;
  investigationStatus: string;
  lifecycleVersion: number;
  alertSource: string;
  /** Short human-readable title; null for sources that supplied none. */
  title: string | null;
  rcaSummary: string | null;
  confidence: number | null;
  trustedAssessmentRunId?: string | null;
  correlationMaxAgeAt?: Date | null;
  latestInvestigationRun?: LatestInvestigationRun | null;
  pendingAutomation?: PendingIncidentAutomation | null;
  queuedResponderWork?: PendingIncidentAutomation | null;
  archivedAt: Date | null;
  createdAt: Date;
}

/** The IncidentSummary column projection, shared by listIncidents / listActiveIncidents / retrieval. */
export const summaryColumns = {
  purpose: incidents.purpose,
  id: incidents.id,
  service: incidents.service,
  severity: incidents.severity,
  status: incidents.status,
  investigationStatus: incidents.investigationStatus,
  lifecycleVersion: incidents.lifecycleVersion,
  alertSource: incidents.alertSource,
  title: incidents.title,
  rcaSummary: incidents.rcaSummary,
  confidence: incidents.confidence,
  trustedAssessmentRunId: incidents.trustedAssessmentRunId,
  correlationMaxAgeAt: incidents.correlationMaxAgeAt,
  latestInvestigationRun: latestInvestigationRunSql(),
  pendingAutomation: pendingIncidentAutomationSql(),
  queuedResponderWork: pendingIncidentAutomationSql(true),
  archivedAt: incidents.archivedAt,
  createdAt: incidents.createdAt,
} as const;

/**
 * Tenant-scoped public incident projection for the dashboard detail route.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 */
export async function getIncidentSummary(
  db: Db,
  tenantId: string,
  id: string,
): Promise<IncidentSummary | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select(summaryColumns)
      .from(incidents)
      .where(and(eq(incidents.id, id), isNull(incidents.archivedAt)))
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface IncidentDetail extends IncidentSummary {
  rankedHypotheses: RankedHypothesisRecord[] | null;
  currentState: string | null;
  impact: string | null;
  assessmentEvidenceIds: string[] | null;
  unknowns: InvestigationGap[] | null;
  nextStep: string | null;
  assessmentUpdatedAt: Date | null;
  recoveryState: 'verifying' | 'monitoring' | 'verified' | 'not_verified' | null;
  recoverySummary: string | null;
  recoveryEvidenceIds: string[] | null;
  recoveryUnknowns: string[] | null;
  recoveryNextStep: string | null;
  recoveryUpdatedAt: Date | null;
  recoveryAttempt: number | null;
  recoveryMaxChecks: number | null;
  recoveryNextCheckAt: Date | null;
  recoveryScheduleReason: string | null;
  occurrenceCount: number;
  deployCorrelated: boolean;
  engineProvider: string | null;
  engineModel: string | null;
  resolvedAt: Date | null;
  mitigatedAt: Date | null;
  closedAt: Date | null;
  updatedAt: Date;
  originSurface: string | null;
  originChannel: string | null;
  originChannelName: string | null;
  originThreadId: string | null;
  pendingApprovalCount: number;
  requiresHumanAttention: boolean;
  attentionReason: IncidentAttentionReason | null;
}

export type IncidentAttentionReason =
  | 'approval_pending'
  | 'investigation_degraded'
  | 'recovery_not_verified'
  | 'resolution_required'
  | 'manual_review'
  | 'signal_tracking_unavailable'
  | 'mitigation_active'
  | 'investigation_inconclusive'
  | 'investigation_blocked'
  | 'budget_exhausted'
  | 'investigation_failed'
  | 'severity_requires_human';

const latestRunOutcomeSql = () => sql<InvestigationRunOutcome | null>`(
  select ${investigationRuns.outcome}
  from ${investigationRuns}
  where ${investigationRuns.tenantId} = ${incidents.tenantId}
    and ${investigationRuns.incidentId} = ${incidents.id}
    and ${investigationRuns.completedAt} is not null
    and not (
      ${investigationRuns.outcome} = 'failed'
      and ${investigationRuns.result} ->> 'reason' = 'superseded_pending_run'
    )
  order by ${investigationRuns.startedAt} desc, ${investigationRuns.id} desc
  limit 1
)`;

const latestRunNeedsAttentionSql = () =>
  sql<boolean>`coalesce(${latestRunOutcomeSql()} <> 'conclusive', false)`;

/** Builds the tenant-scoped total signal count used by incident projections. */
export const signalCountSql = () =>
  sql<number>`(select count(*)::int from ${incidentSignals} where ${incidentSignals.tenantId} = ${incidents.tenantId} and ${incidentSignals.incidentId} = ${incidents.id})`;

/** Builds the tenant-scoped unresolved signal count used by incident projections. */
export const activeSignalCountSql = () =>
  sql<number>`(select count(*)::int from ${incidentSignals} where ${incidentSignals.tenantId} = ${incidents.tenantId} and ${incidentSignals.incidentId} = ${incidents.id} and ${incidentSignals.state} <> 'resolved')`;

const pendingApprovalCountSql = () =>
  sql<number>`(select count(*)::int from ${approvals} where ${approvals.tenantId} = ${incidents.tenantId} and ${approvals.incidentId} = ${incidents.id} and ${approvals.decision} is null)`;

/** One deterministic exception rule shared by list rows, detail rows, ordering, and true tab counts. */
export const humanAttentionCondition = () => sql<boolean>`(
  ${pendingApprovalCountSql()} > 0
  or ${incidents.investigationStatus} = 'degraded'
  or coalesce(${incidents.recoveryState} = 'not_verified', false)
  or (${incidents.alertSource} <> 'manual' and ${signalCountSql()} = 0)
  or (${incidents.alertSource} = 'manual' and ${incidents.investigationStatus} = 'assessed')
  or ${incidents.status} = 'mitigated'
  or (${incidents.status} = 'open' and coalesce(${incidents.recoveryState} = 'verified', false))
  or ${latestRunNeedsAttentionSql()}
  or ${incidents.severity} <> 'sev3'
)`;

const attentionReasonSql = () => sql<IncidentAttentionReason | null>`case
  when ${pendingApprovalCountSql()} > 0 then 'approval_pending'
  when ${latestRunOutcomeSql()} = 'inconclusive' then 'investigation_inconclusive'
  when ${latestRunOutcomeSql()} = 'blocked_missing_capability' then 'investigation_blocked'
  when ${latestRunOutcomeSql()} = 'budget_exhausted' then 'budget_exhausted'
  when ${latestRunOutcomeSql()} = 'failed' then 'investigation_failed'
  when ${incidents.investigationStatus} = 'degraded' then 'investigation_degraded'
  when ${incidents.recoveryState} = 'not_verified' then 'recovery_not_verified'
  when ${incidents.alertSource} <> 'manual' and ${signalCountSql()} = 0 then 'signal_tracking_unavailable'
  when ${incidents.alertSource} = 'manual' and ${incidents.investigationStatus} = 'assessed' then 'manual_review'
  when ${incidents.status} = 'mitigated' then 'mitigation_active'
  when ${incidents.status} = 'open' and ${incidents.recoveryState} = 'verified' then 'resolution_required'
  when ${incidents.severity} <> 'sev3' then 'severity_requires_human'
  else null
end`;

export const attentionColumns = {
  pendingApprovalCount: pendingApprovalCountSql().mapWith(Number),
  requiresHumanAttention: humanAttentionCondition(),
  attentionReason: attentionReasonSql(),
} as const;

/**
 * Tenant-scoped incident detail plus the Slack conversation it was born in.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param id - Value supplied for id.
 */
export async function getIncidentDetail(
  db: Db,
  tenantId: string,
  id: string,
): Promise<IncidentDetail | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        ...summaryColumns,
        rankedHypotheses: incidents.rankedHypotheses,
        currentState: incidents.currentState,
        impact: incidents.impact,
        assessmentEvidenceIds: incidents.assessmentEvidenceIds,
        unknowns: incidents.unknowns,
        nextStep: incidents.nextStep,
        assessmentUpdatedAt: incidents.assessmentUpdatedAt,
        recoveryState: incidents.recoveryState,
        recoverySummary: incidents.recoverySummary,
        recoveryEvidenceIds: incidents.recoveryEvidenceIds,
        recoveryUnknowns: incidents.recoveryUnknowns,
        recoveryNextStep: incidents.recoveryNextStep,
        recoveryUpdatedAt: incidents.recoveryUpdatedAt,
        recoveryAttempt: incidents.recoveryAttempt,
        recoveryMaxChecks: incidents.recoveryMaxChecks,
        recoveryNextCheckAt: incidents.recoveryNextCheckAt,
        recoveryScheduleReason: incidents.recoveryScheduleReason,
        occurrenceCount: incidents.occurrenceCount,
        deployCorrelated: incidents.deployCorrelated,
        engineProvider: incidents.engineProvider,
        engineModel: incidents.engineModel,
        resolvedAt: incidents.resolvedAt,
        mitigatedAt: incidents.mitigatedAt,
        closedAt: incidents.closedAt,
        updatedAt: incidents.updatedAt,
        originSurface: surfaceBindings.surface,
        originChannel: surfaceBindings.channel,
        originChannelName: inboundChannels.channelName,
        originThreadId: surfaceBindings.threadId,
        ...attentionColumns,
      })
      .from(incidents)
      .leftJoin(
        surfaceBindings,
        and(
          eq(surfaceBindings.tenantId, incidents.tenantId),
          eq(surfaceBindings.surface, 'slack'),
          eq(surfaceBindings.incidentId, incidents.id),
          eq(surfaceBindings.role, 'primary'),
        ),
      )
      .leftJoin(
        inboundChannels,
        and(
          eq(inboundChannels.tenantId, surfaceBindings.tenantId),
          eq(inboundChannels.surface, surfaceBindings.surface),
          eq(inboundChannels.channel, surfaceBindings.channel),
        ),
      )
      .where(and(eq(incidents.id, id), isNull(incidents.archivedAt)))
      .limit(1);
    return rows[0] ?? null;
  });
}
