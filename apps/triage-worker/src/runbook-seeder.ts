import { listChunksForMonitorKeys, searchChunks, type Db, type Embedder } from '@sre/db';

/**
 * One runbook, investigation note or learned fact surfaced into the incident brief. Institutional
 * confidence (occurrenceCount + verified) is shown to the engine; the raw cosine score and createdAt
 * are dropped so a similarity number never reads as certainty.
 */
export interface RunbookSeed {
  title: string | null;
  content: string;
  /** 'fact' for a recorded learning; 'runbook' or 'investigation' otherwise. */
  category: string;
  occurrenceCount: number;
  verified: boolean;
}

export interface RunbookSeederDeps {
  /** RLS-scoped connection (app_user); searchChunks scopes rows to the caller's tenant. */
  db: Db;
  embedder: Embedder;
  /** Drop matches below this cosine similarity in [0, 1]. */
  scoreFloor: number;
  /** Max knowledge per source: k exact monitor-key matches plus k similar ones. */
  k: number;
}

export type RunbookSeeder = (
  tenantId: string,
  query: { title?: string; service: string; severity: string; monitorKeys?: string[] },
) => Promise<RunbookSeed[]>;

/**
 * Build the incident brief's knowledge seeder. Knowledge from past incidents that fired the same
 * monitor comes first, with no similarity floor, because an exact alert match is stronger evidence
 * than any score. Then the tenant's chunks most similar to the classifier title (when present),
 * service and severity, above `scoreFloor`. Deduplicated by id, RLS-scoped.
 */
export function makeRunbookSeeder(deps: RunbookSeederDeps): RunbookSeeder {
  return async (tenantId, { title, service, severity, monitorKeys = [] }) => {
    const query = [title, service, severity].filter(Boolean).join(' ');
    const [exact, similar] = await Promise.all([
      listChunksForMonitorKeys(deps.db, tenantId, monitorKeys, deps.k),
      searchChunks(deps.db, deps.embedder, tenantId, {
        category: ['fact', 'runbook', 'investigation'],
        query,
        k: deps.k,
        scoreFloor: deps.scoreFloor,
      }),
    ]);
    const seen = new Set(exact.map((hit) => hit.id));
    return [...exact, ...similar.filter((hit) => !seen.has(hit.id))].map((h) => ({
      title: h.title,
      content: h.content,
      category: h.category,
      occurrenceCount: h.occurrenceCount,
      verified: h.verified,
    }));
  };
}
