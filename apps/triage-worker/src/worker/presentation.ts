import type { TriageResult } from '../engine/types';
import type { RunbookSeed } from '../runbook-seeder';
import type { RecoveryOutcome } from './contracts';

const DEFAULT_TRIAGE_CONTEXT_WINDOW_MIN = 60;

export function triageContextWindowMin(): number {
  const value = Number(process.env.TRIAGE_CONTEXT_WINDOW_MIN);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TRIAGE_CONTEXT_WINDOW_MIN;
}

export function recoveryFinding(
  result: TriageResult,
  outcome: RecoveryOutcome,
  attempt: number,
  maxChecks: number,
  nextCheckAt: Date | null,
): string {
  const recovery = result.recovery;
  const heading =
    outcome === 'recovered'
      ? 'RECOVERED'
      : outcome === 'recheck'
        ? 'MONITORING RECOVERY'
        : 'HUMAN REVIEW NEEDED';
  const lines = [heading, result.summary];
  if (recovery?.evidence.length) {
    lines.push('', 'Checks');
    for (const check of recovery.evidence)
      lines.push(`• ${check.name}: ${check.before ?? 'not recorded'} → ${check.now}`);
  }
  const unknowns = recovery?.unknowns ?? ['Recovery could not be verified.'];
  if (unknowns.length) lines.push('', 'Unknowns', ...unknowns.map((item) => `• ${item}`));
  if (recovery?.nextStep) lines.push('', `Next: ${recovery.nextStep}`);
  if (outcome === 'recheck' && nextCheckAt) {
    lines.push(
      '',
      `Automated check ${attempt} of ${maxChecks}; next check ${nextCheckAt.toISOString()}.`,
      `Reason: ${recovery?.scheduleReason ?? 'The investigator requested another check.'}`,
    );
  }
  return lines.join('\n');
}

export function renderRunbookSeeds(seeds: RunbookSeed[]): string {
  if (seeds.length === 0) return '';
  const items = seeds.map((seed, index) => {
    const confidence = `seen ${seed.occurrenceCount}×, ${seed.verified ? 'verified' : 'unverified'}`;
    return `${index + 1}. ${seed.title ?? 'Untitled runbook'} — ${confidence}\n${seed.content}`;
  });
  return `Related runbooks from past incidents (verify before applying):\n${items.join('\n\n')}`;
}
