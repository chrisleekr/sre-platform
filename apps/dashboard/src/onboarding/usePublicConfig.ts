import { useEffect, useState } from 'react';
import { config } from '../config';
import { loadPublicConfig, type PublicConfig } from '../lib/public-config';

export function usePublicConfig(): {
  value: PublicConfig | null;
  error: boolean;
  retry: () => void;
} {
  const [value, setValue] = useState<PublicConfig | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setError(false);
    void loadPublicConfig(config.publicConfigUrl)
      .then((next) => {
        if (live) setValue(next);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  return { value, error, retry: () => setAttempt((previous) => previous + 1) };
}
