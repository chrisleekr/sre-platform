import type { DeadJob, DeadJobPage, QueueHealth } from '@sre/contracts';
import { useCallback, useState } from 'react';
import type { CredentialGetter } from './request-credentials';
import { useFetchResource } from './useFetchResource';

const EMPTY_HEALTH: QueueHealth = { asOf: '', types: [] };
const EMPTY_PAGE: DeadJobPage = { jobs: [], nextCursor: null };

// Module-level selectors keep useFetchResource's load effect from re-subscribing every render.
const selectHealth = (body: unknown): QueueHealth => {
  const b = (body ?? {}) as Partial<QueueHealth>;
  return { asOf: b.asOf ?? '', types: b.types ?? [] };
};
const selectPage = (body: unknown): DeadJobPage => {
  const b = (body ?? {}) as Partial<DeadJobPage>;
  return { jobs: b.jobs ?? [], nextCursor: b.nextCursor ?? null };
};

/** Reads the tenant's per-type queue counts; `refetch` reloads them on demand. */
export function useQueueHealth(opts: { apiBaseUrl: string; getCredentials: CredentialGetter }) {
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const { data, loading, error } = useFetchResource<QueueHealth>({
    ...opts,
    path: '/queue/health',
    initial: EMPTY_HEALTH,
    select: selectHealth,
    nonce,
  });
  return { health: data, loading, error, refetch };
}

/** Reads one keyset page of dead jobs; changing `cursor` fetches the next page. */
export function useDeadJobs(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  cursor: string | undefined;
  limit: number;
}): {
  jobs: DeadJob[];
  nextCursor: string | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
} {
  const params = new URLSearchParams({ limit: String(opts.limit) });
  if (opts.cursor) params.set('cursor', opts.cursor);
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  const { data, loading, error } = useFetchResource<DeadJobPage>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/queue/dead?${params.toString()}`,
    initial: EMPTY_PAGE,
    select: selectPage,
    nonce,
  });
  return { jobs: data.jobs, nextCursor: data.nextCursor, loading, error, refetch };
}
