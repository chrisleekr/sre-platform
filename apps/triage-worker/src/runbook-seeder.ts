import { searchChunks, type Db, type Embedder } from '@sre/db';

/**
 * One runbook surfaced into the incident-open brief. Institutional confidence
 * (occurrenceCount + verified) is shown to the engine; the raw cosine score and createdAt are dropped
 * so a similarity number never reads as certainty.
 */
export interface RunbookSeed {
  title: string | null;
  content: string;
  occurrenceCount: number;
  verified: boolean;
}

export interface RunbookSeederDeps {
  /** RLS-scoped connection (app_user); searchChunks scopes rows to the caller's tenant. */
  db: Db;
  embedder: Embedder;
  /** Drop matches below this cosine similarity in [0, 1]. */
  scoreFloor: number;
  /** Max runbooks to seed. */
  k: number;
}

export type RunbookSeeder = (
  tenantId: string,
  query: { title?: string; service: string; severity: string },
) => Promise<RunbookSeed[]>;

/**
 * Build the incident-open runbook seeder. The query is the classifier title (when
 * present) plus the incident service and severity; with no title it falls back to service+severity.
 * Ranks the tenant's `runbook` chunks by cosine similarity above `scoreFloor`, RLS-scoped, and maps
 * each hit to institutional confidence only — never the raw score. Nothing above the floor → `[]`.
 */
export function makeRunbookSeeder(deps: RunbookSeederDeps): RunbookSeeder {
  return async (tenantId, { title, service, severity }) => {
    const query = [title, service, severity].filter(Boolean).join(' ');
    const hits = await searchChunks(deps.db, deps.embedder, tenantId, {
      category: ['runbook', 'investigation'],
      query,
      k: deps.k,
      scoreFloor: deps.scoreFloor,
    });
    return hits.map((h) => ({
      title: h.title,
      content: h.content,
      occurrenceCount: h.occurrenceCount,
      verified: h.verified,
    }));
  };
}
