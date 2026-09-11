// Pure error-budget math and its one text rendering. No I/O, so it is unit-tested without
// infrastructure and reused by the scheduled evaluator, the always-bound triage tool, and the
// dashboard. All fractions are event ratios in [0,1]; a "bad ratio" is bad events / total events.
//
// Precondition: 0 < target < 1, enforced at the CRUD boundary and by a database CHECK, so the error
// budget (1 - target) is positive and nothing here divides by zero.

/**
 * Returns the error budget: the fraction of events allowed to be bad over the compliance window.
 *
 * @param target - Target reliability as a fraction strictly between 0 and 1.
 */
export function errorBudget(target: number): number {
  return 1 - target;
}

/**
 * Returns the remaining budget as a signed fraction of the allowance, from the compliance-window bad ratio.
 *
 * @remarks 1 is untouched, 0 is fully spent, and a negative value reports how far over budget it is.
 * @param badRatioComplianceWindow - Bad-event ratio measured over the full compliance window.
 * @param target - Target reliability as a fraction strictly between 0 and 1.
 */
export function budgetRemaining(badRatioComplianceWindow: number, target: number): number {
  return 1 - badRatioComplianceWindow / errorBudget(target);
}

/**
 * Returns how many whole budgets the current bad ratio would spend across one compliance window.
 *
 * @remarks 1 is exactly on track; 14.4 spends a 30-day budget in about 50 hours.
 * @param badRatioShortWindow - Bad-event ratio measured over the short burn window.
 * @param target - Target reliability as a fraction strictly between 0 and 1.
 */
export function burnRate(badRatioShortWindow: number, target: number): number {
  return badRatioShortWindow / errorBudget(target);
}

/**
 * Projects the days until the remaining budget reaches zero at the current burn rate.
 *
 * @remarks Null when not burning; 0 when already exhausted. Linear: at rate 1 a full budget lasts the window.
 * @param budgetRemainingFraction - Remaining budget as a signed fraction of the allowance.
 * @param rate - Current burn rate in budgets per compliance window.
 * @param windowDays - Length of the compliance window in days.
 */
export function projectExhaustionDays(
  budgetRemainingFraction: number,
  rate: number,
  windowDays: number,
): number | null {
  if (rate <= 0) return null;
  if (budgetRemainingFraction <= 0) return 0;
  return (budgetRemainingFraction * windowDays) / rate;
}

/** A computed objective status snapshot, ready to render or return. */
export interface SloStatus {
  name: string;
  service: string;
  sliType: string;
  target: number;
  windowDays: number;
  /** Remaining budget as a fraction; negative means over budget. */
  budgetRemaining: number;
  burnRate: number;
  /** The short window the burn rate was measured over, for example "1h". */
  burnWindow: string;
  /** Days until exhaustion at the current burn rate; null when not burning. */
  exhaustionDays: number | null;
}

const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;

/**
 * Renders the identifying prefix shared by every objective status line.
 *
 * @param slo - Objective identity, target and compliance window.
 */
export function sloHeadline(slo: {
  name: string;
  service: string;
  sliType: string;
  target: number;
  windowDays: number;
}): string {
  return `SLO "${slo.name}" (${slo.service}, ${slo.sliType} ${pct(slo.target)} over ${slo.windowDays}d)`;
}

/**
 * Renders one compact status line: budget remaining, current burn, and the exhaustion projection.
 *
 * @remarks Pure, so the same wording reaches the hub brief, the triage tool and the dashboard.
 * @param status - Computed objective status to render.
 */
export function renderSloStatus(status: SloStatus): string {
  const budget =
    status.budgetRemaining > 0
      ? `${pct(status.budgetRemaining)} budget remaining`
      : `budget EXHAUSTED (over by ${pct(-status.budgetRemaining)})`;
  const burn = `burn ${status.burnRate.toFixed(1)}x over ${status.burnWindow}`;
  const projection =
    status.exhaustionDays === null
      ? 'not burning'
      : status.exhaustionDays === 0
        ? 'budget already exhausted'
        : `budget exhausts in ~${status.exhaustionDays.toFixed(1)} days`;
  return `${sloHeadline(status)}: ${budget}; ${burn}; ${projection}.`;
}
