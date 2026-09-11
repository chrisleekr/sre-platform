import type { CredentialGetter } from './request-credentials';
import { useEffect, useState } from 'react';
import type { IncidentWorkspaceData } from './types';
import { useFetchResource } from './useFetchResource';

const selectWorkspace = (body: unknown): IncidentWorkspaceData => {
  const candidate = body as Partial<IncidentWorkspaceData>;
  if (candidate.incident && candidate.progress) return candidate as IncidentWorkspaceData;
  return {
    incident: body as IncidentWorkspaceData['incident'],
    viewerUserId: null,
    progress: { total: 0, successful: 0, failed: 0, lastRecordedAt: null },
    signals: [],
  };
};

export function useIncidentWorkspace(
  incidentId: string,
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): {
  workspace: IncidentWorkspaceData | null;
  loading: boolean;
  error: 'not-found' | 'load-error' | null;
  refresh: () => void;
} {
  const [nonce, setNonce] = useState(0);
  const { data, loading, error, errorStatus } = useFetchResource<IncidentWorkspaceData | null>({
    apiBaseUrl: opts.apiBaseUrl,
    getCredentials: opts.getCredentials,
    path: `/incidents/${incidentId}/workspace`,
    initial: null,
    select: selectWorkspace,
    nonce,
  });
  // The failure message is published before the queue commits its retry or terminal state.
  const waitingForRetry =
    data?.incident.latestInvestigationRun?.outcome === 'failed' &&
    !!data.incident.pendingAutomation;
  useEffect(() => {
    if (!waitingForRetry) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') setNonce((value) => value + 1);
    }, 15_000);
    return () => clearInterval(timer);
  }, [incidentId, waitingForRetry]);
  return {
    workspace: data,
    loading,
    error: error ? (errorStatus === 404 ? 'not-found' : 'load-error') : null,
    refresh: () => setNonce((value) => value + 1),
  };
}
