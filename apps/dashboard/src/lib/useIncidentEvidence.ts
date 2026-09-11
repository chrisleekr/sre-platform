import type { CredentialGetter } from './request-credentials';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';
import type { EvidenceDetail, EvidenceListItem } from './types';

interface EvidencePage {
  evidence: EvidenceListItem[];
  nextCursor: string | null;
}

export function useIncidentEvidence(
  incidentId: string,
  opts: { apiBaseUrl: string; getCredentials: CredentialGetter },
): {
  evidence: EvidenceListItem[];
  nextCursor: string | null;
  details: Record<string, EvidenceDetail | null>;
  loading: boolean;
  error: boolean;
  paginationError: boolean;
  detailErrors: Record<string, boolean>;
  loadDetail: (id: string) => void;
  loadOlder: () => void;
  refresh: () => void;
} {
  const [evidence, setEvidence] = useState<EvidenceListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, EvidenceDetail | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [paginationError, setPaginationError] = useState(false);
  const [detailErrors, setDetailErrors] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);
  const loadedOlder = useRef(false);

  useEffect(() => {
    loadedOlder.current = false;
    setEvidence([]);
    setNextCursor(null);
    setDetails({});
    setLoading(true);
    setError(false);
    setPaginationError(false);
    setDetailErrors({});
  }, [incidentId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        setLoading(true);
        setError(false);
        const res = await authenticatedFetch(
          `${opts.apiBaseUrl}/incidents/${incidentId}/evidence?limit=20`,
          opts.getCredentials,
        );
        if (!res.ok) throw new Error('evidence list request failed');
        const page = (await res.json()) as EvidencePage;
        if (active) {
          const refreshed = Array.isArray(page.evidence) ? page.evidence : [];
          setEvidence((current) => {
            if (!loadedOlder.current) return refreshed;
            const seen = new Set<string>();
            return [...refreshed, ...current].filter((item) => {
              if (seen.has(item.id)) return false;
              seen.add(item.id);
              return true;
            });
          });
          if (!loadedOlder.current)
            setNextCursor(typeof page.nextCursor === 'string' ? page.nextCursor : null);
          setLoading(false);
        }
      } catch {
        if (active) {
          setLoading(false);
          setError(true);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [incidentId, nonce, opts.apiBaseUrl, opts.getCredentials]);

  const loadDetail = useCallback(
    (id: string) => {
      if (id in details) return;
      setDetailErrors((current) => ({ ...current, [id]: false }));
      setDetails((current) => ({ ...current, [id]: null }));
      void (async () => {
        try {
          const res = await authenticatedFetch(
            `${opts.apiBaseUrl}/incidents/${incidentId}/evidence/${id}`,
            opts.getCredentials,
          );
          if (!res.ok) throw new Error('evidence detail request failed');
          const detail = (await res.json()) as EvidenceDetail;
          setDetails((current) => ({ ...current, [id]: detail }));
        } catch {
          // Remove the loading marker so expanding the card again retries the request.
          setDetails((current) => {
            const next = { ...current };
            delete next[id];
            return next;
          });
          setDetailErrors((current) => ({ ...current, [id]: true }));
        }
      })();
    },
    [details, incidentId, opts.apiBaseUrl, opts.getCredentials],
  );

  const loadOlder = useCallback(() => {
    if (!nextCursor) return;
    const cursor = nextCursor;
    setNextCursor(null);
    setPaginationError(false);
    void (async () => {
      try {
        const res = await authenticatedFetch(
          `${opts.apiBaseUrl}/incidents/${incidentId}/evidence?limit=20&before=${encodeURIComponent(cursor)}`,
          opts.getCredentials,
        );
        if (!res.ok) throw new Error('evidence page request failed');
        const page = (await res.json()) as EvidencePage;
        loadedOlder.current = true;
        setEvidence((current) => [...current, ...page.evidence]);
        setNextCursor(page.nextCursor);
        setPaginationError(false);
      } catch {
        setNextCursor(cursor);
        setPaginationError(true);
      }
    })();
  }, [incidentId, nextCursor, opts.apiBaseUrl, opts.getCredentials]);

  return {
    evidence,
    nextCursor,
    details,
    loading,
    error,
    paginationError,
    detailErrors,
    loadDetail,
    loadOlder,
    refresh: () => setNonce((value) => value + 1),
  };
}
