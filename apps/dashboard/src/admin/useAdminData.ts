import { requestErrorMessage } from '../lib/request-error';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Loads one administrator projection and exposes explicit refresh state. */
export function useAdminData<T>(load: () => Promise<T>) {
  const loadRef = useRef(load);
  const loadedRef = useRef(false);
  loadRef.current = load;
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const refresh = useCallback(async () => {
    if (!loadedRef.current) setLoading(true);
    setError(undefined);
    try {
      setData(await loadRef.current());
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Administrator data is unavailable.'));
    } finally {
      loadedRef.current = true;
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}
