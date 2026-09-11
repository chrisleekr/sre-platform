import type { CredentialGetter } from './request-credentials';
import { useState } from 'react';
import type { Incident } from './types';
import { useFetchResource } from './useFetchResource';

export type IncidentDetailError = 'not-found' | 'load-error';

const selectIncident = (body: unknown): Incident => body as Incident;

export function useIncidentDetail(
  incidentId: string,
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): {
  incident: Incident | null;
  loading: boolean;
  error: IncidentDetailError | null;
  retry: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const { data, loading, error, errorStatus } = useFetchResource<Incident | null>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/incidents/${incidentId}`,
    initial: null,
    select: selectIncident,
    nonce,
  });

  return {
    incident: data,
    loading,
    error: error ? (errorStatus === 404 ? 'not-found' : 'load-error') : null,
    retry: () => setNonce((value) => value + 1),
  };
}
