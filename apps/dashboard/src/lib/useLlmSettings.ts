import { checkResponse } from './request-error';
import type { CredentialGetter } from './request-credentials';
import { useCallback, useState } from 'react';
import type { LlmSettingsResponse, UpdateLlmSettingsRequest } from '@sre/contracts';
import { authenticatedFetch } from './authenticatedFetch';
import { useFetchResource } from './useFetchResource';

const selectSettings = (body: unknown): LlmSettingsResponse => body as LlmSettingsResponse;

export function useLlmSettings(opts: { apiBaseUrl: string; getCredentials: CredentialGetter }) {
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((value) => value + 1), []);
  const settings = useFetchResource<LlmSettingsResponse | null>({
    ...opts,
    path: '/platform-settings/llm',
    initial: null,
    select: selectSettings,
    nonce,
  });
  return {
    settings: settings.data,
    loading: settings.loading,
    error: settings.error,
    errorStatus: settings.errorStatus,
    refetch,
  };
}

export async function saveLlmSettings(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  input: UpdateLlmSettingsRequest,
): Promise<LlmSettingsResponse> {
  const response = await authenticatedFetch(`${apiBaseUrl}/platform-settings/llm`, getCredentials, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  await checkResponse(response, 'Investigator settings could not be saved. Refresh and retry.');
  return (await response.json()) as LlmSettingsResponse;
}
