import type { CredentialGetter } from './request-credentials';
import { useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';

/**
 * The authenticated-resource primitive shared by dashboard data hooks. Active-guarded so a late response
 * after unmount is dropped; the access token authorizes every read on a Bearer header. It supports a
 * one-shot read, explicit refetch by changing `nonce`, and polling via `pollMs`. Polling keeps the last-good
 * data visible on failure; `backgroundError` is true only when an interval refresh fails after a success
 * for the same mounted path. One-shot and explicit-refetch consumers expose loading for each request.
 *
 * `select` extracts the typed value from the parsed JSON body; pass a STABLE (module-level) function so
 * the load effect does not re-subscribe on every render.
 */
export function useFetchResource<T>(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
  path: string;
  initial: T;
  select: (body: unknown) => T;
  pollMs?: number;
  nonce?: number;
}): {
  data: T;
  loading: boolean;
  error: boolean;
  errorStatus: number | null;
  backgroundError: boolean;
} {
  const { apiBaseUrl, getCredentials, path, initial, select, pollMs, nonce } = opts;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [backgroundError, setBackgroundError] = useState(false);
  // The path that the CURRENT `data` was loaded for. When `path` changes (a new ?cursor/?state), the
  // load effect fires but `setLoading(true)` only lands in the NEXT commit — for one render `data` is the
  // PREVIOUS page while `loading` is still false. A consumer that appends per-page off `loading===false`
  // (IncidentsPanel) would append the stale page under the new cursor. Fold "not yet loaded for this path"
  // into `loading` so that stale window reads as loading.
  const loadedPathRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    let hasSuccessfulLoad = false;
    let inFlight = false;
    setBackgroundError(false);
    // The poll variant keeps loading/error steady across background polls (no flicker, no blank); the
    // one-shot/refetch variants reset them here so a refetch shows loading and clears any prior error.
    if (pollMs === undefined) {
      setLoading(true);
      setError(false);
      setErrorStatus(null);
    }
    const load = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      let failedStatus: number | null = null;
      try {
        const res = await authenticatedFetch(`${apiBaseUrl}${path}`, getCredentials);
        if (!res.ok) {
          failedStatus = res.status;
          throw new Error('request failed');
        }
        const body = (await res.json()) as unknown;
        if (active) {
          hasSuccessfulLoad = true;
          setData(select(body));
          setError(false);
          setErrorStatus(null);
          setBackgroundError(false);
        }
      } catch {
        if (active) {
          setError(true); // retain the last-good data
          setErrorStatus(failedStatus);
          setBackgroundError(pollMs !== undefined && hasSuccessfulLoad);
        }
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          // Mark this path as settled (success OR error), so `loading` can drop for it. Set on error too,
          // else a failed first load would leave loadedPathRef null and `loading` stuck true forever.
          loadedPathRef.current = path;
        }
      }
    };
    void load();
    if (pollMs !== undefined) {
      const timer = setInterval(() => void load(), pollMs);
      return () => {
        active = false;
        clearInterval(timer);
      };
    }
    return () => {
      active = false;
    };
  }, [apiBaseUrl, getCredentials, path, pollMs, nonce, select]);

  // `loading` stays true through the stale render after a path change, until the fetch for THIS path lands
  // (loadedPathRef catches up). For a stable path loadedPathRef === path, so there is no behavior change.
  return {
    data,
    loading: loading || loadedPathRef.current !== path,
    error,
    errorStatus,
    backgroundError,
  };
}
