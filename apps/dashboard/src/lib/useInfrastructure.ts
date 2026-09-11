import type { CredentialGetter } from './request-credentials';
import type { InfraSnapshot } from './types';
import { useFetchResource } from './useFetchResource';

export interface UseInfrastructure {
  snapshots: InfraSnapshot[];
  loading: boolean;
  error: boolean;
  errorStatus: number | null;
  backgroundError: boolean;
}

/** The worker refreshes the snapshot cache every 30 seconds, so the dashboard follows that cadence. */
const POLL_MS = 30_000;

const selectSnapshots = (body: unknown): InfraSnapshot[] =>
  (body as { infrastructure: InfraSnapshot[] }).infrastructure;

/**
 * Fetch the tenant's infrastructure snapshots and follow the worker's refresh cadence. The shared
 * polling primitive retains the last-good result when a background request fails.
 */
export function useInfrastructure(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  pollMs?: number;
}): UseInfrastructure {
  const { data, loading, error, errorStatus, backgroundError } = useFetchResource<InfraSnapshot[]>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/infrastructure',
    initial: [],
    select: selectSnapshots,
    pollMs: opts.pollMs ?? POLL_MS,
  });
  return { snapshots: data, loading, error, errorStatus, backgroundError };
}
