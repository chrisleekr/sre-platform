/** Live work for one job type. Completed jobs are excluded; they say nothing about queue health. */
export interface QueueHealthRow {
  type: string;
  queued: number;
  processing: number;
  dead: number;
  /** Earliest `available_at` among queued jobs already due, so delayed work never reads as waiting. */
  oldestDueAt: string | null;
}

/** `GET /queue/health`: the tenant's live and dead-lettered work, one row per job type. */
export interface QueueHealth {
  asOf: string;
  types: QueueHealthRow[];
}

/** One dead-lettered job. The payload is never exposed; only the incident it names, if it exists. */
export interface DeadJob {
  id: string;
  type: string;
  attempts: number;
  /** Set only when the named incident exists in the same tenant, so the link always resolves. */
  incidentId: string | null;
  incidentTitle: string | null;
  /** Credential-scrubbed and shortened for display. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** `GET /queue/dead`: newest dead jobs first, keyset-paged by an opaque cursor. */
export interface DeadJobPage {
  jobs: DeadJob[];
  nextCursor: string | null;
}
