import type { CredentialGetter } from './request-credentials';
import type { IncidentFreeStatus } from './incidentFreeStatus';
import type { Incident } from './types';
import { useFetchResource } from './useFetchResource';

/** Server orderings for the incident list; `priority` is valid only for the open scope. */
export type IncidentSort = 'priority' | 'newest' | 'oldest' | 'severity';

export interface UseIncidents {
  operationalCounts?: UseIncidents['counts'];
  incidents: Incident[];
  /** True per-scope totals from the server; null on the legacy no-`state` path. */
  counts: {
    all: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  } | null;
  /** Opaque cursor for the next Closed or All history page; null when there is no further page. */
  nextCursor: string | null;
  incidentFreeStatus: IncidentFreeStatus;
  loading: boolean;
  error: boolean;
  backgroundError: boolean;
}

interface IncidentsBody {
  operationalCounts?: UseIncidents['counts'];
  incidents: Incident[];
  counts?: {
    all: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  };
  nextCursor?: string | null;
  incidentFreeStatus?: IncidentFreeStatus;
}

const UNAVAILABLE_INCIDENT_FREE_STATUS: IncidentFreeStatus = {
  state: 'unavailable',
  asOf: null,
  startedAt: null,
  qualifyingActiveCount: 0,
  scope: { severities: ['sev1', 'sev2'] },
  lastIncident: null,
};

// Stable (module-level) selector so useFetchResource's load effect does not re-subscribe each render.
// Tolerates BOTH response shapes: the `?state=` body carries counts + nextCursor; the legacy body is a
// bare `{ incidents }`.
const selectBody = (body: unknown): IncidentsBody => {
  const b = (body ?? {}) as IncidentsBody;
  return {
    incidents: b.incidents ?? [],
    counts: b.counts,
    operationalCounts: b.operationalCounts,
    nextCursor: b.nextCursor ?? null,
    incidentFreeStatus: b.incidentFreeStatus ?? UNAVAILABLE_INCIDENT_FREE_STATUS,
  };
};

const EMPTY: IncidentsBody = {
  incidents: [],
  nextCursor: null,
  incidentFreeStatus: UNAVAILABLE_INCIDENT_FREE_STATUS,
};

/**
 * Fetch the tenant's incidents from the API (the access token authorizes + scopes them). With `state` the
 * server filters by scope and returns true per-scope counts + a keyset cursor; without it, the
 * legacy full-list path. `sort` picks the server ordering; a history cursor is only valid for the
 * ordering it was issued under, so changing `sort` must reset the cursor. Changing a filter or cursor
 * re-runs the fetch because it rides the request path. An
 * explicit poll interval applies only to the Open scope; Closed keyset pages remain one-shot.
 */
export function useIncidents(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  state?: 'open' | 'closed' | 'all';
  sort?: IncidentSort;
  query?: string;
  severity?: 'sev1' | 'sev2' | 'sev3';
  cursor?: string;
  limit?: number;
  pollMs?: number;
}): UseIncidents {
  const params = new URLSearchParams();
  if (opts.state) params.set('state', opts.state);
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.query) params.set('query', opts.query);
  if (opts.severity) params.set('severity', opts.severity);
  if (opts.cursor) params.set('cursor', opts.cursor);
  if (opts.limit) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const path = qs ? `/incidents?${qs}` : '/incidents';

  const { data, loading, error, backgroundError } = useFetchResource<IncidentsBody>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path,
    initial: EMPTY,
    select: selectBody,
    pollMs: opts.state === 'open' ? opts.pollMs : undefined,
  });
  return {
    incidents: data.incidents,
    counts: data.counts ?? null,
    operationalCounts: data.operationalCounts ?? null,
    nextCursor: data.nextCursor ?? null,
    incidentFreeStatus: error
      ? UNAVAILABLE_INCIDENT_FREE_STATUS
      : (data.incidentFreeStatus ?? UNAVAILABLE_INCIDENT_FREE_STATUS),
    loading,
    error,
    backgroundError,
  };
}
