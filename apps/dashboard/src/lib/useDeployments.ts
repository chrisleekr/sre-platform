import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { Deployment } from './types';
import { useFetchResource } from './useFetchResource';

export interface UseDeployments {
  deployments: Deployment[];
  summary: DeploymentSummary;
  /** Opaque cursor for the next (older) deploy page; null when there is no further page. */
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  /** Re-fires the load without changing the cursor; the panel's only retry for a failed same-cursor page. */
  refetch: () => void;
}

export interface DeploymentSummary {
  total: number;
  failed: number;
  active: number;
  environmentMissing: number;
  latestAt: string | null;
}

export interface DeploymentFilters {
  from?: string;
  to?: string;
  search?: string;
  service?: string;
  environment?: string;
  source?: string;
  status?: string;
}

interface DeploymentsBody {
  deployments: Deployment[];
  nextCursor?: string | null;
  summary?: DeploymentSummary;
}

const EMPTY_SUMMARY: DeploymentSummary = {
  total: 0,
  failed: 0,
  active: 0,
  environmentMissing: 0,
  latestAt: null,
};

// Stable (module-level) selector so useFetchResource's load effect does not re-subscribe each render.
// Tolerates BOTH response shapes: the paginated body carries a nextCursor; the legacy body is a bare
// `{ deployments }` (the panel's first, windowed load).
const selectBody = (body: unknown): DeploymentsBody => {
  const b = (body ?? {}) as DeploymentsBody;
  return {
    deployments: b.deployments ?? [],
    nextCursor: b.nextCursor ?? null,
    summary: b.summary ?? EMPTY_SUMMARY,
  };
};

const EMPTY: DeploymentsBody = {
  deployments: [],
  nextCursor: null,
  summary: EMPTY_SUMMARY,
};

/**
 * Fetch the tenant's deployments from the API (the access token authorizes + scopes them). Passing
 * `cursor` pages older history via keyset; the paginated body carries a `nextCursor`. Changing
 * `cursor` re-runs the fetch (it rides the request path).
 */
export function useDeployments(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  cursor?: string;
  limit?: number;
  filters?: DeploymentFilters;
}): UseDeployments {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', String(opts.limit));
  for (const [key, value] of Object.entries(opts.filters ?? {})) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  const path = qs ? `/deployments?${qs}` : '/deployments';

  // Bumping the nonce re-runs the load effect; refetch() retries a failed same-cursor "Load older" that
  // setCursor would bail via Object.is. Functional updater guarantees a fresh value.
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const { data, loading, error } = useFetchResource<DeploymentsBody>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path,
    initial: EMPTY,
    select: selectBody,
    nonce,
  });
  return {
    deployments: data.deployments,
    summary: data.summary ?? EMPTY_SUMMARY,
    nextCursor: data.nextCursor ?? null,
    loading,
    error,
    refetch,
  };
}
