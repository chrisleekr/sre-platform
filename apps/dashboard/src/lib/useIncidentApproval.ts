import { authenticatedFetch } from './authenticatedFetch';
import { useCallback, useState } from 'react';
import { checkResponse, requestErrorMessage } from './request-error';
import type { CredentialGetter } from './request-credentials';

/**
 * Keep decision failures visible; only the stream confirms a persisted decision.
 * @param apiBaseUrl - Platform API address.
 * @param getCredentials - Active workspace session.
 * @param incidentId - Incident owning the approval.
 */
export function useIncidentApproval(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  incidentId: string,
): { error: string | null; decide: (approvalId: string, optionId: string) => Promise<void> } {
  const [error, setError] = useState<string | null>(null);
  const decide = useCallback(
    async (approvalId: string, optionId: string) => {
      setError(null);
      const fallback = 'The decision could not be confirmed. Refresh the incident before retrying.';
      try {
        const response = await authenticatedFetch(
          `${apiBaseUrl}/incidents/${encodeURIComponent(incidentId)}/approvals/${encodeURIComponent(approvalId)}/decide`,
          getCredentials,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ optionId }),
          },
        );
        await checkResponse(response, fallback);
      } catch (cause) {
        setError(requestErrorMessage(cause, fallback));
      }
    },
    [apiBaseUrl, getCredentials, incidentId],
  );
  return { error, decide };
}
