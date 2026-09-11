import type { CredentialGetter } from './request-credentials';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse, requestErrorMessage } from './request-error';
import type { Attachment } from './types';

/**
 * Fetch an incident's attachment metadata once. Metadata only — the bytes
 * are fetched lazily and per-file through the authenticated proxy when an image scrolls into view.
 * The access token authorizes + tenant-scopes the list.
 */
export function useAttachments(
  incidentId: string | null,
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): { attachments: Attachment[]; error: string | null; retry: () => void } {
  const { apiBaseUrl, getCredentials } = opts;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setError(null);
    setAttachments([]);
    if (!incidentId) return;
    let active = true;
    void (async () => {
      try {
        const res = await authenticatedFetch(
          `${apiBaseUrl}/incidents/${incidentId}/attachments`,
          getCredentials,
        );
        await checkResponse(res, 'Attachments could not be loaded. Retry.');
        const body = (await res.json()) as { attachments: Attachment[] };
        if (active) setAttachments(body.attachments);
      } catch (cause) {
        if (active) setError(requestErrorMessage(cause, 'Attachments could not be loaded. Retry.'));
      }
    })();
    return () => {
      active = false;
    };
  }, [incidentId, apiBaseUrl, getCredentials, nonce]);

  return { attachments, error, retry: () => setNonce((value) => value + 1) };
}
