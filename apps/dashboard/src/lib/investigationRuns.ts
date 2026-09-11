import type { Incident } from './types';

export interface PendingIncidentWork {
  type: string;
  status: 'queued' | 'processing';
  scheduledAt: string;
}

const labels: Record<NonNullable<Incident['latestInvestigationRun']>['outcome'], string> = {
  conclusive: 'Conclusive',
  inconclusive: 'Inconclusive',
  blocked_missing_capability: 'Blocked by missing capability',
  budget_exhausted: 'Budget exhausted',
  failed: 'Failed',
};

const operationLabels: Record<
  NonNullable<Incident['latestInvestigationRun']>['operation'],
  string
> = {
  investigate: 'Investigate',
  reassess: 'Reassess',
  resume: 'Resume',
  'verify-recovery': 'Verify recovery',
};

const triggerLabels: Record<
  NonNullable<NonNullable<Incident['latestInvestigationRun']>['triggerReason']>,
  string
> = {
  new_episode: 'New alert episode',
  state_transition: 'Alert state changed',
  material_change: 'Material signal change',
  unchanged_renotification: 'Unchanged notification',
  human_continuation: 'Responder message',
  recovery_verification: 'Recovery verification',
  manual_investigation: 'Manual investigation',
};

export function investigationRunOperationLabel(
  operation: NonNullable<Incident['latestInvestigationRun']>['operation'],
): string {
  return operationLabels[operation];
}

export function investigationRunOutcomeLabel(
  outcome: NonNullable<Incident['latestInvestigationRun']>['outcome'],
): string {
  return labels[outcome];
}

export function investigationRunTriggerLabel(
  reason: NonNullable<Incident['latestInvestigationRun']>['triggerReason'],
): string {
  return reason ? triggerLabels[reason] : 'Legacy run';
}

function budgetValue(value: number, limit: number, unit: 'runs' | 'USD'): string {
  const current = unit === 'USD' ? `$${value.toFixed(2)}` : String(value);
  const maximum =
    limit === 0 ? 'unlimited' : unit === 'USD' ? `$${limit.toFixed(2)}` : String(limit);
  return `${current} / ${maximum} ${unit}`;
}

export function investigationBudgetSnapshotLabel(
  budget: NonNullable<NonNullable<Incident['latestInvestigationRun']>['triggerBudget']>,
  prefix = 'Current 24h budget',
): string {
  const tenantUncertainty = `${budget.tenant.pendingCostRuns > 0 ? `, ${budget.tenant.pendingCostRuns} pending cost` : ''}${budget.tenant.missingUsageRuns > 0 ? `, ${budget.tenant.missingUsageRuns} missing usage` : ''}${budget.tenant.unpricedRuns > 0 ? `, ${budget.tenant.unpricedRuns} unpriced` : ''}`;
  const scopes = [
    `tenant ${budgetValue(budget.tenant.runs, budget.tenant.runLimit, 'runs')}, ${budgetValue(
      budget.tenant.configuredCostUsd,
      budget.tenant.configuredCostLimitUsd,
      'USD',
    )}${tenantUncertainty}`,
  ];
  for (const [index, monitor] of (budget.monitors ?? []).entries()) {
    scopes.push(
      `monitor ${index + 1}: ${budgetValue(monitor.runs, monitor.runLimit, 'runs')}, ${budgetValue(
        monitor.configuredCostUsd,
        monitor.configuredCostLimitUsd,
        'USD',
      )}${monitor.pendingCostRuns > 0 ? `, ${monitor.pendingCostRuns} pending cost` : ''}${monitor.missingUsageRuns > 0 ? `, ${monitor.missingUsageRuns} missing usage` : ''}${monitor.unpricedRuns > 0 ? `, ${monitor.unpricedRuns} unpriced` : ''}`,
    );
  }
  return `${prefix}: ${scopes.join('; ')}`;
}

export function investigationRunBudgetLabel(
  run: NonNullable<Incident['latestInvestigationRun']>,
): string | null {
  const budget = run.triggerBudget;
  if (!budget) return null;
  return investigationBudgetSnapshotLabel(budget, '24h before run');
}
