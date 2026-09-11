import type { ConnectorConfig } from '../../registry';
import type { HostLookup } from '../../ssrf';
import type { SliRatioReader } from '../../types';
import { obj } from '../../values';
import { connect, ppost, type FetchLike, type PrometheusConnectorOptions } from './client';

// The Prometheus service level indicator reader. It evaluates the operator's stored expression in
// Prometheus and returns only the scalar answer, so the platform stores computed burn events and never
// SLI samples.
//
// It rides the shared `connect` + `ppost` path, so the SSRF-validated base URL, the header-only
// credential, the fixed read path and the 8 second timeout are inherited rather than re-implemented.

/** Placeholder an operator writes in the stored expression where the evaluation window belongs. */
const WINDOW_PLACEHOLDER = /\$window/g;

/** Prometheus instant-query endpoint. A constant, never a caller value. */
const QUERY_PATH = '/api/v1/query';

/**
 * Substitute the window as whole seconds. Seconds are always a legal Prometheus duration, so no
 * window is ever rounded into a different one on the way to the backend.
 */
function withWindow(query: string, windowSeconds: number): string {
  return query.replace(WINDOW_PLACEHOLDER, `${Math.max(1, Math.round(windowSeconds))}s`);
}

/** Float noise tolerated at the boundaries before a value counts as genuinely outside the range. */
const RATIO_EPSILON = 1e-9;

/**
 * Enforce the documented contract, a finite bad-event ratio in [0,1], so a malformed answer never
 * becomes a budget. An expression returning a raw count instead of a ratio would otherwise report a
 * budget overrun of millions of percent, and a slightly negative value, which histogram rate
 * extrapolation can produce, would make the budget read better than perfect and the burn rate
 * negative, so the service would look healthier than it is. Only boundary float noise is clamped;
 * anything genuinely outside the range fails loudly, matching the rest of this reader.
 */
function toRatio(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('prometheus sli: query did not resolve to a numeric ratio');
  }
  if (value < -RATIO_EPSILON || value > 1 + RATIO_EPSILON) {
    throw new Error(`prometheus sli: ratio ${value} is outside the documented [0,1] range`);
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * Read the single sample out of an instant-query response. A vector carrying more than one series is
 * rejected rather than resolved arbitrarily: picking one would put some other series' ratio behind
 * this objective's budget. An empty result is rejected too, because a query that matched nothing is
 * not evidence that nothing is failing.
 */
function extractSample(payload: unknown): number {
  const data = obj(obj(payload).data);
  const result = data.result;
  if (data.resultType === 'scalar') {
    return toRatio(Array.isArray(result) ? result[1] : undefined);
  }
  if (!Array.isArray(result) || result.length !== 1) {
    throw new Error(
      `prometheus sli: expected exactly one series, received ${Array.isArray(result) ? result.length : 0}`,
    );
  }
  const value = obj(result[0]).value;
  return toRatio(Array.isArray(value) ? value[1] : undefined);
}

/**
 * Builds the Prometheus service level indicator reader for one connector instance.
 *
 * @remarks A tenant running two Prometheus instances is disambiguated by connector id, not by this reader.
 * @param config - Tenant-scoped Prometheus settings and credential accessor.
 * @param fetchImpl - HTTP transport used for Prometheus API requests.
 * @param lookup - DNS resolver used by SSRF validation.
 * @param options - Exact supervised loopback origins allowed during development.
 */
export function makePrometheusSli(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup,
  options: PrometheusConnectorOptions = {},
): SliRatioReader {
  return {
    async sliRatio(request) {
      const client = await connect(config, lookup, options);
      const payload = await ppost(fetchImpl, client, QUERY_PATH, {
        query: withWindow(request.query, request.windowSeconds),
      });
      return extractSample(payload);
    },
  };
}
