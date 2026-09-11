// Error-budget thresholds shared by the dashboard and the server that stamps deploys. They live in
// the contracts package because a copy per workspace lets one surface be tuned without the other,
// and a panel that disagrees with the deploy stamp about "nearly out" is silently wrong on both.

/**
 * Remaining-budget fraction below which a budget counts as nearly spent. Advisory everywhere it is
 * used: surfaces report it and none of them block, gate or revert anything.
 */
export const HIGH_RISK_BUDGET_THRESHOLD = 0.1;
