// The read model: objective status for a service, and for the whole tenant. It sources the LATEST
// persisted burn event per objective, so it needs no metrics backend of its own and shows whatever the
// scheduled evaluator last computed.
//
// This module reports. It never opens an incident, enqueues work, or reaches a surface: the package
// depends on the database workspace alone, which is what makes that structural rather than a promise.

import { listSlos, listSlosByService, recentBurnEventsForSlos, type Db } from '@sre/db';
import { projectExhaustionDays, renderSloStatus, sloHeadline } from './compute';

/** One objective's status: its definition plus the latest evaluation, or null while awaiting one. */
export interface SloStatusView {
  name: string;
  service: string;
  sliType: string;
  target: number;
  windowDays: number;
  /**
   * Why the most recent evaluation attempt failed, or null when it succeeded or none has run.
   *
   * @remarks Evaluation is best-effort by contract: a query the backend rejects writes no burn event
   * and never dead-letters the job. Without this field an objective whose query is wrong is
   * indistinguishable from one that is merely new, and the operator's only signal is a worker log
   * line they cannot reach. Already scrubbed and truncated by the writer.
   */
  lastEvaluationError: string | null;
  /** When the current failure was first seen, as an ISO 8601 string. Null whenever there is none. */
  evaluationFailingSince: string | null;
  /** Present once a burn event exists; null before the first evaluation persists. */
  evaluation: {
    /** Remaining budget as a signed fraction; negative means over budget. */
    budgetRemaining: number;
    burnRate: number;
    burnWindow: string;
    exhaustionDays: number | null;
    /**
     * When the evaluator computed these figures, as an ISO 8601 string. Every surface must show the
     * age with the number: evaluation failures are swallowed by design, so an objective whose
     * connector was deleted or whose credential expired simply stops receiving new burn events and
     * the last one is served forever. A timestamp far older than the evaluation interval means the
     * budget below is not current, not that the budget stopped moving.
     */
    computedAt: string;
  } | null;
}

// Both reads project the latest persisted burn event the same way, and the exhaustion projection is
// derived here on read rather than stored.
function toEvaluation(
  latest: { budgetPct: number; burnRate: number; window: string; computedAt: Date } | undefined,
  windowDays: number,
): SloStatusView['evaluation'] {
  if (!latest) return null;
  return {
    budgetRemaining: latest.budgetPct,
    burnRate: latest.burnRate,
    burnWindow: latest.window,
    exhaustionDays: projectExhaustionDays(latest.budgetPct, latest.burnRate, windowDays),
    // Serialised, not a Date: this crosses the wire to the dashboard and reaches the model through
    // the triage tool, and both need one stable representation.
    computedAt: latest.computedAt.toISOString(),
  };
}

/**
 * Reads the enabled objectives for one service, each with its latest budget and burn.
 *
 * @remarks Failures propagate: a caller that must not degrade, such as the incident opener, catches them.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read.
 * @param service - Canonical service the objectives target.
 */
export async function sloStatusForService(
  db: Db,
  tenantId: string,
  service: string,
): Promise<Array<SloStatusView & { metricQuery: string; connectorType: string }>> {
  const definitions = await listSlosByService(db, tenantId, service);
  // One windowed read for the latest event of every objective, instead of N per-objective queries.
  const byId = await recentBurnEventsForSlos(
    db,
    tenantId,
    definitions.map((definition) => definition.id),
    1,
  );
  return definitions.map((slo) => ({
    metricQuery: slo.metricQuery,
    connectorType: slo.connectorType,
    name: slo.name,
    service: slo.service,
    sliType: slo.sliType,
    target: slo.target,
    windowDays: slo.windowDays,
    lastEvaluationError: slo.lastEvalError ?? null,
    evaluationFailingSince: slo.evalFailingSince?.toISOString() ?? null,
    evaluation: toEvaluation(byId.get(slo.id)?.[0], slo.windowDays),
  }));
}

/**
 * Renders the budget section of the incident-opening brief: one line per objective.
 *
 * @remarks A service with no objectives renders an empty string, so the brief drops the section entirely.
 * @param views - Objective statuses to render.
 */
export function renderSloBrief(views: SloStatusView[]): string {
  if (views.length === 0) return '';
  const lines = views.map((view) => {
    const body = view.evaluation
      ? // The measurement time is part of the figure. The brief is a durable message a responder reads
        // later, evaluation failures are swallowed by design, and an objective that stopped refreshing
        // keeps serving its last result, so a budget with no age reads as current when it is not.
        `${renderSloStatus({
          name: view.name,
          service: view.service,
          sliType: view.sliType,
          target: view.target,
          windowDays: view.windowDays,
          budgetRemaining: view.evaluation.budgetRemaining,
          burnRate: view.evaluation.burnRate,
          burnWindow: view.evaluation.burnWindow,
          exhaustionDays: view.evaluation.exhaustionDays,
        })} Measured ${view.evaluation.computedAt}.`
      : `${sloHeadline(view)}: awaiting first evaluation.`;
    // A responder reading a stale or absent number needs to know the objective is failing rather than
    // merely new, and the reason is the actionable half.
    if (view.lastEvaluationError === null) return body;
    // The two fields are written together, so the null branch is unreachable in practice. It is here
    // because the alternative is printing the word "null" into a durable message a responder reads.
    const since =
      view.evaluationFailingSince === null ? '' : ` since ${view.evaluationFailingSince}`;
    return `${body} Evaluation failing${since}: ${briefError(view.lastEvaluationError)}`;
  });
  return `SLO status:\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

/**
 * The brief is a durable message posted to a thread and read by the model, and the stored message can
 * be the first 500 characters of a backend error page. Enough to identify the failure, not enough for
 * several failing objectives to crowd out the incident.
 */
const BRIEF_ERROR_LEN = 140;

function briefError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length <= BRIEF_ERROR_LEN ? flat : `${flat.slice(0, BRIEF_ERROR_LEN - 1)}\u2026`;
}

/** One dashboard row: an objective's status plus its identity and enabled flag. */
export interface SloDashboardRow extends SloStatusView {
  id: string;
  enabled: boolean;
}

/**
 * Reads every objective the tenant owns, each with its latest evaluation.
 *
 * @remarks Disabled objectives are included so an operator can see and re-enable them.
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read.
 */
export async function sloDashboard(db: Db, tenantId: string): Promise<SloDashboardRow[]> {
  const definitions = await listSlos(db, tenantId);
  // One windowed read for the latest event of every objective, instead of N per-objective queries.
  // The panel renders one evaluation per objective, so reading more per objective would be rows
  // fetched on every poll and thrown away.
  const byId = await recentBurnEventsForSlos(
    db,
    tenantId,
    definitions.map((definition) => definition.id),
    1,
  );
  return definitions.map((slo) => ({
    id: slo.id,
    enabled: slo.enabled,
    name: slo.name,
    service: slo.service,
    sliType: slo.sliType,
    target: slo.target,
    windowDays: slo.windowDays,
    lastEvaluationError: slo.lastEvalError ?? null,
    evaluationFailingSince: slo.evalFailingSince?.toISOString() ?? null,
    evaluation: toEvaluation(byId.get(slo.id)?.[0], slo.windowDays),
  }));
}
