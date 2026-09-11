// The SLI source port. The ratio query is pushed DOWN to the metrics backend, which already holds the
// time series, so the platform stores objective definitions and burn events and never SLI samples.
//
// No production reader lives here: this package depends on the database workspace alone, so the
// adapter that maps this port onto a tenant's connectors is wired in the worker that owns connectors.

/** One ratio question for a tenant's metrics backend. */
export interface SliQuery {
  tenantId: string;
  /** Which metrics connector type to run the query against. */
  connectorType: string;
  /** Backend-native expression returning the bad-event ratio. */
  query: string;
  /** The window to evaluate over, in seconds. */
  windowSeconds: number;
}

/** The metrics-backend port the evaluator reads through. */
export interface SliReader {
  /** Returns the bad-event ratio in [0,1] over the window (errors/total, or slow/total for latency). */
  querySliRatio(query: SliQuery): Promise<number>;
}

/**
 * Raised when no connector can serve the objective's query, as distinct from a backend that failed.
 *
 * @remarks A missing capability is a configuration gap an operator can fix, not an outage to retry.
 */
export class SliUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SliUnsupportedError';
  }
}
