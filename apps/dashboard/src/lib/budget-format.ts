// Budget wording shared by the Error budgets panel and the deploy list. Both surfaces render the
// same signed fraction, so re-deriving the string per surface is how one of them ends up printing an
// overage as a negative percentage while the other spells it out.

/** Formats a fraction as a one-decimal percentage. */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Budget headline for a signed remaining-budget fraction. An overage reads as an overage, never as
 * a negative percentage.
 *
 * @param remaining - Remaining budget as a signed fraction; negative means over budget.
 */
export function budgetLabel(remaining: number): string {
  return remaining < 0
    ? `Over budget by ${formatPercent(-remaining)}`
    : `${formatPercent(remaining)} budget left`;
}
