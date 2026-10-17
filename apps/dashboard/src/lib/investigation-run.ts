import type { InvestigationBudgetSnapshot, InvestigationTriggerReason } from '@sre/contracts';

/** The incident's most recent completed investigation run, as the incident detail projects it. */
export interface LatestInvestigationRun {
  id: string;
  operation: 'investigate' | 'reassess' | 'resume' | 'verify-recovery';
  outcome:
    'conclusive' | 'inconclusive' | 'blocked_missing_capability' | 'budget_exhausted' | 'failed';
  triggerReason: InvestigationTriggerReason | null;
  triggerAutomatic: boolean;
  triggerMonitorKey: string | null;
  triggerMonitorKeys: string[];
  triggerBudget: InvestigationBudgetSnapshot | null;
  summary?: string | null;
  nextStep?: string | null;
  gaps?: string[];
  likelyCause?: string | null;
  impact?: string | null;
  reason?: string | null;
  completedAt: string;
}
