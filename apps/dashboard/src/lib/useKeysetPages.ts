import { useEffect, useState } from 'react';

/** One settled keyset page, keyed by the cursor that produced it (`undefined` for the first page). */
export interface Page<T> {
  cursor: string | undefined;
  rows: T[];
}

interface UseKeysetPagesInput<T> {
  /** The cursor that produced `page`. Owned by the panel: it rides the request path, so it must be
      declared before the fetch whose result lands here (see the note on ownership below). */
  cursor: string | undefined;
  /** The current page from the fetch hook. Read only once settled. */
  page: T[];
  loading: boolean;
  error: boolean;
  /**
   * Whether the current fetch belongs to this accumulation. IncidentsPanel paginates only its closed
   * archive, so its open-tab fetches must never be appended.
   */
  enabled?: boolean;
  /** Clears accumulated pages when the surrounding query scope changes. */
  resetKey?: string;
}

export interface UseKeysetPages<T> {
  /** Every page accumulated so far, oldest first. */
  pages: Page<T>[];
  /** Those pages flattened, in arrival order. */
  rows: T[];
}

/**
 * the keyset page accumulation shared by IncidentsPanel and DeploymentsPanel. Owns the accumulation,
 * dedupe-by-cursor and flattening, and nothing else.
 *
 * The cursor `useState` stays in each panel on purpose. The cursor is an INPUT to the fetch and the fetch's
 * result is an input to this accumulation, so a hook owning both ends would have to own the fetch call
 * itself. That trade buys one deduplicated `useState` line and costs a hook that reaches into every panel's
 * data loading, so the cursor is passed in instead.
 *
 * Deliberately NOT here, because the panels diverge and each divergence is a requirement rather than drift:
 * - `firstLoad`: DeploymentsPanel keys it on this accumulation, IncidentsPanel on the server counts,
 *   so it cannot be derived once.
 * - error semantics: DeploymentsPanel keeps rows mounted under the banner, IncidentsPanel unmounts them
 *Pinned on both sides by DeploymentsPanel.test.tsx (characterization) and
 *   IncidentsPanel.test.tsx "an error during a refetch hides the tab bar and rows".
 * - the `shown` source: IncidentsPanel is dual-source (open tab reads the live slice so a scope switch
 * cannot leak stale rows); DeploymentsPanel always reads the accumulation.
 * - blanking: two levels in IncidentsPanel, one in DeploymentsPanel.
 * A hook owning any of those would have to break one panel to serve the other.
 */
export function useKeysetPages<T>({
  cursor,
  page,
  loading,
  error,
  enabled = true,
  resetKey,
}: UseKeysetPagesInput<T>): UseKeysetPages<T> {
  const [pages, setPages] = useState<Page<T>[]>([]);

  useEffect(() => {
    setPages([]);
  }, [resetKey]);

  // Append each settled page exactly once, keyed by the cursor that produced it, so paging GROWS the list
  // rather than replacing it. Runs only for a settled (non-loading) fetch, so a stale mid-fetch page under a
  // new cursor is never appended (useFetchResource holds `loading` true until the new path settles).
  useEffect(() => {
    if (!enabled || loading || error) return;
    setPages((prev) =>
      prev.some((p) => p.cursor === cursor) ? prev : [...prev, { cursor, rows: page }],
    );
  }, [enabled, loading, error, cursor, page]);

  return { pages, rows: pages.flatMap((p) => p.rows) };
}
