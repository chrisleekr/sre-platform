import type { SliReader } from './sli-reader';
import { budgetRemaining, burnRate, projectExhaustionDays } from './compute';

// One objective evaluation: query the compliance window for the budget and the short window for the
// current burn, then persist ONE burn event. Nothing else is written; the platform stores no SLI
// samples, so the persist port accepts a burn event and nothing that could store one.
//
// Best-effort by contract: a reader or persist failure returns null through `onError` and never
// rethrows, which is what lets the scheduled evaluator complete-and-skip a failing tenant instead of
// accumulating dead-lettered work. The next window re-evaluates from scratch.

/** The short "current burn" window every persisted burn event is measured over. */
export const DEFAULT_BURN_WINDOW = { label: '1h', seconds: 3600 } as const;

const SECONDS_PER_DAY = 86_400;

/** The objective fields the evaluator needs: a subset of one `slos` row. */
export interface SloForEval {
  id: string;
  tenantId: string;
  name: string;
  service: string;
  sliType: string;
  target: number;
  windowDays: number;
  metricQuery: string;
  connectorType: string;
}

/** One computed burn sample plus the projection derived on read. */
export interface BurnSample {
  sloId: string;
  /** Remaining budget as a signed fraction of the allowance. */
  budgetPct: number;
  burnRate: number;
  window: string;
  exhaustionDays: number | null;
}

/** The ports one evaluation runs on. */
export interface EvaluatorDeps {
  reader: SliReader;
  /** Persists one burn event, already bound to a tenant by the caller. */
  persist: (event: {
    sloId: string;
    budgetPct: number;
    burnRate: number;
    window: string;
  }) => Promise<unknown>;
  burnWindow?: { label: string; seconds: number };
  /** Best-effort error sink; the evaluator never rethrows. */
  onError?: (error: unknown, slo: SloForEval) => void;
}

/**
 * Evaluates one objective and persists a single burn event, returning the sample it computed.
 *
 * @remarks Best-effort: a reader or persist failure returns null through `onError` without rethrowing.
 * @param deps - Metrics reader, burn-event sink, optional window and error sink.
 * @param slo - The objective to evaluate.
 */
export async function evaluateSlo(
  deps: EvaluatorDeps,
  slo: SloForEval,
): Promise<BurnSample | null> {
  const burnWindow = deps.burnWindow ?? DEFAULT_BURN_WINDOW;
  try {
    const target = {
      tenantId: slo.tenantId,
      connectorType: slo.connectorType,
      query: slo.metricQuery,
    };
    // Compliance window gives the budget remaining; the short window gives the current burn rate.
    const complianceRatio = await deps.reader.querySliRatio({
      ...target,
      windowSeconds: slo.windowDays * SECONDS_PER_DAY,
    });
    const shortRatio = await deps.reader.querySliRatio({
      ...target,
      windowSeconds: burnWindow.seconds,
    });

    const budgetPct = budgetRemaining(complianceRatio, slo.target);
    const rate = burnRate(shortRatio, slo.target);
    const exhaustionDays = projectExhaustionDays(budgetPct, rate, slo.windowDays);

    await deps.persist({ sloId: slo.id, budgetPct, burnRate: rate, window: burnWindow.label });
    return { sloId: slo.id, budgetPct, burnRate: rate, window: burnWindow.label, exhaustionDays };
  } catch (error) {
    // A failing backend, a missing capability, or a write outage must not dead-letter the objective.
    deps.onError?.(error, slo);
    return null;
  }
}
