// Error-budget wire types, kept beside the rest of the wire contracts and re-exported from `types.ts`
// so consumers import them from one place.

/** The latest evaluation of one objective, as the objective status endpoint returns it. */
export interface SloEvaluation {
  /** Remaining budget as a signed fraction; negative means the objective is over budget. */
  budgetRemaining: number;
  burnRate: number;
  burnWindow: string;
  exhaustionDays: number | null;
  /**
   * When the evaluator computed these figures, as an ISO 8601 string. A failed evaluation is
   * swallowed and no new burn event is written, so a broken objective keeps serving its last
   * result. A timestamp far older than the evaluation interval means the numbers beside it are
   * stale, not that the budget stopped moving. Render the age with the number.
   */
  computedAt: string;
}

/** One objective row on the Error budgets panel: its definition plus its latest evaluation. */
export interface SloRow {
  id: string;
  name: string;
  service: string;
  sliType: string;
  target: number;
  windowDays: number;
  enabled: boolean;
  /**
   * Why the most recent evaluation attempt failed, or null when it succeeded or none has run.
   * A failed attempt writes no burn event, so without this an objective whose query the backend
   * rejects looks identical to one that is merely waiting for its first run.
   */
  lastEvaluationError: string | null;
  /** When the current failure was first seen, as an ISO 8601 string. Null whenever there is none. */
  evaluationFailingSince: string | null;
  /** Null until the scheduled evaluator has persisted a first burn event. */
  evaluation: SloEvaluation | null;
}
