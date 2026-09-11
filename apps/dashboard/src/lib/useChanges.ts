import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { ChangeEvent } from './types';
import { useFetchResource } from './useFetchResource';

export interface ChangeSummary {
  total: number;
  failing: number;
  succeeded: number;
  latestAt: string | null;
}

export interface ChangeSourceHealth {
  id: string;
  name: string;
  provider: 'github' | 'gitlab';
  enabled: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  count: number;
  failureCategory: string | null;
}

interface ChangesBody {
  changes: ChangeEvent[];
  nextCursor: string | null;
  summary: ChangeSummary;
  sources: ChangeSourceHealth[];
}

const EMPTY: ChangesBody = {
  changes: [],
  nextCursor: null,
  summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
  sources: [],
};

const selectBody = (value: unknown): ChangesBody => {
  const body = (value ?? {}) as Partial<ChangesBody>;
  return {
    changes: body.changes ?? [],
    nextCursor: body.nextCursor ?? null,
    summary: body.summary ?? EMPTY.summary,
    sources: body.sources ?? [],
  };
};

export function useChanges(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  cursor?: string;
  limit?: number;
  filters?: Record<string, string | undefined>;
}) {
  const params = new URLSearchParams();
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', String(opts.limit));
  for (const [key, value] of Object.entries(opts.filters ?? {})) if (value) params.set(key, value);
  const query = params.toString();
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  const { data, loading, error } = useFetchResource<ChangesBody>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: query ? `/changes?${query}` : '/changes',
    initial: EMPTY,
    select: selectBody,
    nonce,
  });
  return { ...data, loading, error, refetch };
}
