import type { CredentialGetter } from './request-credentials';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse, requestErrorMessage } from './request-error';
import type { HubMessage } from './types';

interface HistoryPage {
  messages: HubMessage[];
  nextCursor: string | null;
}

export function useIncidentHistory(
  incidentId: string,
  liveMessages: HubMessage[],
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): {
  messages: HubMessage[];
  hasOlder: boolean;
  loadingOlder: boolean;
  error: string | null;
  loadOlder: () => void;
  refresh: () => void;
  retry: () => void;
} {
  const [stored, setStored] = useState<HubMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [olderFailed, setOlderFailed] = useState(false);
  const generation = useRef(0);
  const [nonce, setNonce] = useState(0);
  const loadedOlder = useRef(false);

  useEffect(() => {
    generation.current += 1;
    loadedOlder.current = false;
    setStored([]);
    setNextCursor(null);
    setError(null);
    setOlderFailed(false);
    setLoadingOlder(false);
    return () => {
      generation.current += 1;
    };
  }, [incidentId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const res = await authenticatedFetch(
          `${opts.apiBaseUrl}/incidents/${incidentId}/messages?limit=100`,
          opts.getCredentials,
        );
        await checkResponse(res, 'Conversation history could not be loaded. Retry.');
        const page = (await res.json()) as HistoryPage;
        if (active) {
          setError(null);
          const refreshed = Array.isArray(page.messages) ? page.messages : [];
          setStored((current) => {
            if (!loadedOlder.current) return refreshed;
            const byId = new Map(current.map((message) => [message.id, message]));
            for (const message of refreshed) byId.set(message.id, message);
            return [...byId.values()].sort(
              (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
            );
          });
          if (!loadedOlder.current)
            setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
        }
      } catch (cause) {
        if (active) setOlderFailed(false);
        if (active)
          setError(requestErrorMessage(cause, 'Conversation history could not be loaded. Retry.'));
      }
    })();
    return () => {
      active = false;
    };
  }, [incidentId, opts.apiBaseUrl, opts.getCredentials, nonce]);

  const loadOlder = useCallback(() => {
    if (!nextCursor || loadingOlder) return;
    setLoadingOlder(true);
    const requestedGeneration = generation.current;
    void (async () => {
      try {
        const res = await authenticatedFetch(
          `${opts.apiBaseUrl}/incidents/${incidentId}/messages?limit=100&before=${encodeURIComponent(nextCursor)}`,
          opts.getCredentials,
        );
        await checkResponse(res, 'Older conversation history could not be loaded. Retry.');
        const page = (await res.json()) as HistoryPage;
        if (requestedGeneration !== generation.current) return;
        loadedOlder.current = true;
        setError(null);
        setStored((current) => [
          ...(Array.isArray(page.messages) ? page.messages : []),
          ...current,
        ]);
        setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
      } catch (cause) {
        if (requestedGeneration !== generation.current) return;
        setOlderFailed(true);
        setError(
          requestErrorMessage(cause, 'Older conversation history could not be loaded. Retry.'),
        );
      } finally {
        if (requestedGeneration === generation.current) setLoadingOlder(false);
      }
    })();
  }, [incidentId, loadingOlder, nextCursor, opts.apiBaseUrl, opts.getCredentials]);

  const messages = useMemo(() => {
    const byId = new Map<string, HubMessage>();
    for (const message of stored) byId.set(message.id, message);
    // Live rows win for content, while a REST receipt is retained until the next refresh carries it.
    for (const message of liveMessages) {
      const persisted = byId.get(message.id);
      byId.set(message.id, {
        ...persisted,
        ...message,
        displayContent:
          persisted?.content === message.content ? persisted.displayContent : undefined,
        authorDisplayName:
          persisted?.content === message.content ? persisted.authorDisplayName : undefined,
        slackDelivery: message.slackDelivery ?? persisted?.slackDelivery ?? null,
        slackDeliveries: message.slackDeliveries ?? persisted?.slackDeliveries ?? [],
      });
    }
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  }, [liveMessages, stored]);

  return {
    messages,
    hasOlder: nextCursor !== null,
    loadingOlder,
    error,
    loadOlder,
    refresh: () => setNonce((value) => value + 1),
    retry: () => (olderFailed ? loadOlder() : setNonce((value) => value + 1)),
  };
}
