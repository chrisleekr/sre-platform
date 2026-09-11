// Queue-driven error-budget evaluation, mirroring the connector poller. A scheduler fans out one
// `slo-eval` job per (tenant x enabled objective) onto a SEPARATE Valkey stream, guarded so exactly
// one replica enqueues per window; a consumer group runs the handler, which resolves the objective,
// queries its metrics backend, computes budget and burn, and persists ONE burn event.
//
// The error budget is a read model, never an ingress. The handler is given exactly two write ports, a
// burn-event sink and an outcome sink that records why an attempt failed on the objective row, and
// nothing else: it cannot open an incident, enqueue triage work, or reach a surface.
//
// Everything is best-effort. A missing capability, a failing backend or a vanished objective skips
// without rethrowing, so an objective is never dead-lettered and the next window starts clean. Ports
// are injected so the orchestration unit-tests with no Postgres or Valkey.

import type { IDataSourceConnector } from '@sre/connectors';
import type { Job } from '@sre/queue';
import { evaluateSlo, SliUnsupportedError, type SliReader, type SloForEval } from '@sre/slo';
import type { WindowGuard } from './poller';

/** The narrow queue port the scheduler needs: enqueue only. The real `Queue` satisfies it. */
export interface SloDispatcher {
  enqueue(input: { tenantId: string; type: string; payload: unknown }): Promise<string>;
}

/**
 * Evaluation cadence: one fan-out every five minutes across all replicas.
 *
 * The compliance-window query is a range read as wide as the objective's window, up to 30 days,
 * against the tenant's own metrics backend, and it is real network cost on every evaluation. A 30-day
 * budget does not need 60-second freshness, so the cadence is deliberately coarse.
 */
export const SLO_EVAL_INTERVAL_MS = 300_000;

/**
 * How many fan-out windows pass between retention sweeps. The evaluator appends one row per objective
 * per window and nothing else removes them, so the table needs a sweep, but a table whose retention
 * bound is measured in months does not need one every five minutes. At the default cadence this is
 * once a day, and it rides the fan-out's existing window guard rather than adding a second lock.
 */
export const PRUNE_EVERY_N_WINDOWS = 288;

/** One computed burn event the handler persists. */
export interface BurnEventInput {
  sloId: string;
  budgetPct: number;
  burnRate: number;
  window: string;
}

export interface SloEvalHandlerDeps {
  /** Resolves one objective by id under the given tenant. Null when deleted or disabled since enqueue. */
  resolveSlo: (tenantId: string, sloId: string) => Promise<SloForEval | null>;
  /** Persists one burn event under the given tenant. The only write this handler can make. */
  persist: (tenantId: string, event: BurnEventInput) => Promise<unknown>;
  /** The metrics source. Defaults to a reader that reports no capability rather than fabricating one. */
  reader?: SliReader;
  /**
   * Per-evaluation reader factory, preferred over `reader` when given. One call per job, so a reader
   * that memoizes anything derived from a tenant's credentials holds it for one evaluation only.
   */
  readerFor?: () => SliReader;
  /**
   * Records the outcome of the attempt on the objective row: null on success, the failure message
   * otherwise. Best-effort like everything else here, so a failure to record a failure is swallowed.
   */
  recordOutcome?: (tenantId: string, sloId: string, error: string | null) => Promise<unknown>;
  /** Best-effort error sink. */
  onError?: (error: unknown, context: { tenantId: string; sloId: string }) => void;
}

interface SloEvalPayload {
  sloId?: string;
}

/** A reader for a deployment with no metrics connector wired: reports absence, never a number. */
function unconfiguredReader(): SliReader {
  return {
    async querySliRatio(query) {
      throw new SliUnsupportedError(
        `no ${query.connectorType} connector is configured to serve an SLI query`,
      );
    },
  };
}

/**
 * Handle one `slo-eval` job: resolve the objective named in the payload, evaluate it, and persist a
 * burn event. A job of another type, an empty payload, or an objective removed since enqueue is a
 * no-op. `evaluateSlo` is itself best-effort, and a resolve failure is swallowed, so an objective is
 * never dead-lettered: the next window re-enqueues it.
 */
export function makeSloEvalHandler(deps: SloEvalHandlerDeps): (job: Job) => Promise<void> {
  const fallbackReader = deps.reader ?? unconfiguredReader();
  return async (job: Job): Promise<void> => {
    if (job.type !== 'slo-eval') return;
    const { sloId } = (job.payload ?? {}) as SloEvalPayload;
    if (!sloId) return;

    // The tenant comes from the job row, never from the payload: a payload is model- and
    // provider-adjacent data, and rebinding the tenant from it would cross the isolation boundary.
    const slo = await deps.resolveSlo(job.tenantId, sloId).catch((error) => {
      deps.onError?.(error, { tenantId: job.tenantId, sloId });
      return null;
    });
    if (!slo) return;

    // One reader per evaluation: `evaluateSlo` asks for two ratios, and both must share a single
    // connector resolution rather than decrypting the tenant's credentials twice.
    let failure: string | null = null;
    await evaluateSlo(
      {
        reader: deps.readerFor?.() ?? fallbackReader,
        persist: (event) => deps.persist(job.tenantId, event),
        onError: (error) => {
          failure = error instanceof Error ? error.message : String(error);
          deps.onError?.(error, { tenantId: job.tenantId, sloId });
        },
      },
      slo,
    );

    // The outcome is written whether the attempt succeeded or failed: a success must clear a previous
    // failure, or a transient backend outage would mark the objective broken forever. Swallowed like
    // the evaluation itself, because failing to record an outcome must not dead-letter the job.
    await deps.recordOutcome?.(job.tenantId, sloId, failure).catch((error) => {
      deps.onError?.(error, { tenantId: job.tenantId, sloId });
    });
  };
}

/**
 * Maps the read model's metrics port onto the tenant's connectors. It lives here, in the worker that
 * already owns connector resolution, so the read-model package keeps its database-only dependency.
 *
 * An objective names a connector TYPE, which cannot tell two Prometheus instances on one tenant
 * apart. The choice is therefore pinned by connector id: the lowest id that exposes the capability
 * wins, so the same objective always reads the same instance. An objective that needs a specific
 * instance is not expressible today; that would need a connector id on the objective row.
 *
 * @param resolveConnectors - Returns the tenant's enabled connectors.
 */
export function makeConnectorSliReader(
  resolveConnectors: (tenantId: string) => Promise<IDataSourceConnector[]>,
): SliReader {
  return {
    async querySliRatio(query) {
      const connectors = await resolveConnectors(query.tenantId);
      const candidate = connectors
        .filter((connector) => connector.type === query.connectorType && connector.sli)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
      if (!candidate?.sli) {
        throw new SliUnsupportedError(
          `no enabled ${query.connectorType} connector exposes an SLI reader for this tenant`,
        );
      }
      return candidate.sli.sliRatio({
        query: query.query,
        windowSeconds: query.windowSeconds,
      });
    },
  };
}

/**
 * Builds the per-evaluation reader factory `SloEvalHandlerDeps.readerFor` takes.
 *
 * @remarks Each returned reader memoizes `resolveConnectors` per tenant for its own lifetime, so the
 * two ratio queries of one evaluation share a single resolution. The memo is deliberately not
 * process-wide or time-based: the resolver decrypts every one of the tenant's connector credentials,
 * and secrets are decrypted at the point of use, so the plaintext dies with the evaluation.
 * @param resolveConnectors - Returns the tenant's enabled connectors.
 */
export function makeConnectorSliReaderFactory(
  resolveConnectors: (tenantId: string) => Promise<IDataSourceConnector[]>,
): () => SliReader {
  return () => {
    const memo = new Map<string, Promise<IDataSourceConnector[]>>();
    return makeConnectorSliReader((tenantId) => {
      let pending = memo.get(tenantId);
      if (!pending) {
        pending = resolveConnectors(tenantId);
        memo.set(tenantId, pending);
      }
      return pending;
    });
  };
}

export interface SloSchedulerDeps {
  guard: WindowGuard;
  dispatch: SloDispatcher;
  listTenants: () => Promise<{ id: string }[]>;
  /** Enabled objectives for a tenant. */
  listEnabledSlos: (tenantId: string) => Promise<{ id: string }[]>;
  /**
   * Removes one capped batch of burn events past the retention bound for a tenant and reports how many
   * it removed. Omit to disable the sweep.
   */
  pruneBurnEvents?: (tenantId: string) => Promise<number>;
  intervalMs?: number;
  /** Window-lock TTL; defaults to the interval so it self-clears before the next window. */
  windowTtlSec?: number;
}

/**
 * Enqueues `slo-eval` jobs on a cadence, guarded so exactly one replica fans out per window. Mirrors
 * PollScheduler: idempotent start, error-swallowing tick. Each won window enumerates tenants and their
 * enabled objectives and enqueues one evaluation job for each. No reconcile driver: evaluations are
 * periodic and self-heal through the next window's fan-out, so a lost dispatch recovers on its own.
 */
export class SloScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: SloSchedulerDeps) {}

  /** True while the interval is active. */
  get running(): boolean {
    return this.timer !== null;
  }

  /** One scheduling pass. Returns the number of evaluation jobs enqueued, 0 if the window was contended. */
  async tick(): Promise<number> {
    const intervalMs = this.deps.intervalMs ?? SLO_EVAL_INTERVAL_MS;
    const ttlSec = this.deps.windowTtlSec ?? Math.max(1, Math.ceil(intervalMs / 1000));
    // Date.now is fine here: the window is a coarse, monotonically increasing bucket.
    const windowId = Math.floor(Date.now() / intervalMs);
    if (!(await this.deps.guard(windowId, ttlSec))) return 0;

    let enqueued = 0;
    const tenants = await this.deps.listTenants();
    for (const { id: tenantId } of tenants) {
      const objectives = await this.deps.listEnabledSlos(tenantId);
      for (const objective of objectives) {
        await this.deps.dispatch.enqueue({
          tenantId,
          type: 'slo-eval',
          payload: { sloId: objective.id },
        });
        enqueued++;
      }
    }

    // Every tenant is fanned out before any tenant is swept. Interleaving the two would put each
    // tenant's sweep ahead of the NEXT tenant's fan-out, so on a large installation the last tenants
    // would have their evaluation delayed by every earlier tenant's delete, and a slow sweep could
    // push the fan-out past the window it belongs to. Swallowed per tenant so one failure does not
    // stop the sweep for the rest.
    const prune = this.deps.pruneBurnEvents;
    if (prune && windowId % PRUNE_EVERY_N_WINDOWS === 0) {
      for (const { id: tenantId } of tenants) await prune(tenantId).catch(() => 0);
    }
    return enqueued;
  }

  /** Starts the cadence. Idempotent: a second call while running is a no-op. */
  start(intervalMs: number = SLO_EVAL_INTERVAL_MS): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick().catch(() => {}), intervalMs);
  }

  /** Stops the cadence. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
