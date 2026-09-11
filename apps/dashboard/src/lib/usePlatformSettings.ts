import { checkResponse } from './request-error';
import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';
import { useFetchResource } from './useFetchResource';

export interface PlatformSetting {
  key: string;
  value: number;
  defaultValue: number;
}

export interface UsePlatformSettings {
  settings: PlatformSetting[];
  loading: boolean;
  error: boolean;
  errorStatus: number | null;
  refetch: () => void;
}

const selectSettings = (body: unknown): PlatformSetting[] =>
  (body as { settings: PlatformSetting[] }).settings;

export function usePlatformSettings(opts: {
  apiBaseUrl: string;
  getCredentials: CredentialGetter;
}): UsePlatformSettings {
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  const { data, loading, error, errorStatus } = useFetchResource<PlatformSetting[]>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: '/platform-settings',
    initial: [],
    select: selectSettings,
    nonce,
  });
  return { settings: data, loading, error, errorStatus, refetch };
}

export async function savePlatformSetting(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  key: string,
  value: number,
): Promise<{ key: string; value: number }> {
  const response = await authenticatedFetch(
    `${apiBaseUrl}/platform-settings/${encodeURIComponent(key)}`,
    getCredentials,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    },
  );
  await checkResponse(
    response,
    'The setting update could not be confirmed. Refresh its value before retrying.',
  );
  return (await response.json()) as { key: string; value: number };
}
