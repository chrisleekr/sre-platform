import type { SloRow } from './types';
import { useFetchResource } from './useFetchResource';
import type { CredentialGetter } from './request-credentials';

export interface UseSloStatus {
  slos: SloRow[];
  loading: boolean;
  error: boolean;
  errorStatus: number | null;
  backgroundError: boolean;
}

/** The evaluator runs every five minutes, so a slower refresh than the live panels is enough. */
const POLL_MS = 60_000;

const EMPTY: SloRow[] = [];

// Module-level so the load effect does not re-subscribe on every render.
const selectSlos = (body: unknown): SloRow[] => (body as { slos?: SloRow[] }).slos ?? EMPTY;

/**
 * Fetch the tenant's objectives, each with its latest evaluation and when that was computed.
 *
 * @remarks A read model: this hook reports budget state and never triggers an action on it.
 */
export function useSloStatus(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  pollMs?: number;
}): UseSloStatus {
  const { data, loading, error, errorStatus, backgroundError } = useFetchResource<SloRow[]>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/slos/status',
    initial: EMPTY,
    select: selectSlos,
    pollMs: opts.pollMs ?? POLL_MS,
  });
  return { slos: data, loading, error, errorStatus, backgroundError };
}
