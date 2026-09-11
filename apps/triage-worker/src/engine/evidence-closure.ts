import type { InvestigationGap } from '@sre/contracts';

export interface EvidenceReceipt {
  evidenceId: string;
  tool: string;
  outcome: 'complete' | 'partial' | 'unavailable';
}

export interface EvidenceClosureDecision {
  challenge: boolean;
  message: string | null;
}

/**
 * Challenge one draft only when it leaves a machine-checkable question with no cited attempt. The
 * model still chooses the diagnostic operations; this gate only prevents a valid JSON shape from
 * silently ending an investigation before those operations are tried.
 */
export function evidenceClosureDecision(
  gaps: InvestigationGap[],
  receipts: readonly EvidenceReceipt[],
  options: { challengeUsed: boolean; canContinue: boolean },
): EvidenceClosureDecision {
  if (options.challengeUsed || !options.canContinue) return { challenge: false, message: null };
  const durable = new Set(receipts.map((receipt) => receipt.evidenceId));
  const unattempted = gaps.filter(
    (gap) =>
      (gap.category === 'observable' || gap.category === 'partial_evidence') &&
      !gap.attemptedEvidenceIds.some((evidenceId) => durable.has(evidenceId)),
  );
  if (unattempted.length === 0) return { challenge: false, message: null };

  const questions = unattempted
    .slice(0, 8)
    .map((gap) => `- [${gap.evidenceKind ?? 'unspecified'}] ${gap.question.slice(0, 240)}`)
    .join('\n');
  return {
    challenge: true,
    message:
      'The draft leaves machine-checkable questions without a cited evidence attempt. Search the ' +
      'incident evidence ledger first, then use the available provider tools only for missing or stale ' +
      'facts. Submit a revised report. Keep a question only when a cited check was partial or failed, ' +
      'the required capability or history is unavailable, evidence conflicts, or a human decision is ' +
      `required.\n${questions}`,
  };
}
