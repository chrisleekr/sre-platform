import { useEffect, useState } from 'react';
import type { ResolutionPolicy } from '@sre/contracts';
import { config } from '../../config';
import { authenticatedFetch } from '../../lib/authenticatedFetch';
import { checkResponse, requestErrorMessage } from '../../lib/request-error';
import type { CredentialGetter } from '../../lib/request-credentials';
import type { Incident } from '../../lib/types';

/** Save a reasoned policy change against the displayed lifecycle version. */
export function useResolutionPolicy(
  incident: Incident,
  reason: string,
  clearReason: () => void,
  getCredentials: CredentialGetter,
  refreshWorkspace: () => void,
) {
  const [resolutionPolicy, setResolutionPolicy] = useState<ResolutionPolicy>(
    incident.resolutionPolicy ?? 'verified_recovery',
  );
  const [resolutionPolicyPending, setPending] = useState(false);
  const [resolutionPolicyError, setError] = useState<string | null>(null);
  useEffect(
    () => setResolutionPolicy(incident.resolutionPolicy ?? 'verified_recovery'),
    [incident.resolutionPolicy, incident.lifecycleVersion],
  );
  async function changeResolutionPolicy() {
    if (!reason.trim() || resolutionPolicyPending) return;
    setPending(true);
    setError(null);
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/incidents/${incident.id}/resolution-policy`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            policy: resolutionPolicy,
            reason: reason.trim(),
            requestId: crypto.randomUUID(),
            expectedVersion: incident.lifecycleVersion,
          }),
        },
      );
      if (response.status === 409) refreshWorkspace();
      await checkResponse(
        response,
        response.status === 409
          ? 'Incident state changed. Review it and try again.'
          : 'Resolution policy change failed.',
      );
      // The reason box is shared with lifecycle transitions; a stale reason would be reused there.
      clearReason();
      refreshWorkspace();
    } catch (error) {
      setError(requestErrorMessage(error, 'Resolution policy change failed.'));
    } finally {
      setPending(false);
    }
  }
  return {
    resolutionPolicy,
    setResolutionPolicy,
    resolutionPolicyPending,
    resolutionPolicyError,
    changeResolutionPolicy,
  };
}
