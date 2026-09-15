import type { CredentialGetter } from './request-credentials';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from './authenticatedFetch';
import type { EvidenceDetail, EvidenceListItem } from './types';

interface EvidencePage {
  evidence: EvidenceListItem[];
  nextCursor: string | null;
}
const merge = (first: EvidenceListItem[], second: EvidenceListItem[]) => {
  const seen = new Set<string>();
  return [...first, ...second]
    .filter((item) => {
      if (seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .sort(
      (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b.id.localeCompare(a.id),
    );
};

export function useIncidentEvidence(
  incidentId: string,
  opts: {
    apiBaseUrl: string;
    getCredentials: CredentialGetter;
  },
) {
  const [data, setData] = useState({
    incidentId,
    evidence: [] as EvidenceListItem[],
    nextCursor: null as string | null,
    details: {} as Record<string, EvidenceDetail | null>,
    loading: true,
    loadingOlder: false,
    error: false,
    paginationError: false,
    detailErrors: {} as Record<string, boolean>,
  });
  const [nonce, setNonce] = useState(0);
  const identity = useRef(incidentId);
  const generation = useRef(0);
  const inFlight = useRef(new Set<string>());
  const pageBusy = useRef(false);
  const headBusy = useRef(true);
  const cache = useRef<Record<string, EvidenceDetail>>({});
  if (identity.current !== incidentId) {
    identity.current = incidentId;
    generation.current++;
    inFlight.current = new Set();
    cache.current = {};
    pageBusy.current = false;
    headBusy.current = true;
  }
  const current = data.incidentId === incidentId;
  const nextCursor = current ? data.nextCursor : null;
  const refresh = useCallback(() => {
    headBusy.current = true;
    generation.current++;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    const epoch = ++generation.current;
    pageBusy.current = false;
    headBusy.current = true;
    const valid = () => identity.current === incidentId && generation.current === epoch;
    setData((old) =>
      old.incidentId === incidentId
        ? { ...old, loading: true, loadingOlder: false, error: false }
        : {
            incidentId,
            evidence: [],
            nextCursor: null,
            details: {},
            loading: true,
            loadingOlder: false,
            error: false,
            paginationError: false,
            detailErrors: {},
          },
    );
    void authenticatedFetch(
      `${opts.apiBaseUrl}/incidents/${incidentId}/evidence?limit=20`,
      opts.getCredentials,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error('Evidence unavailable');
        const page = (await res.json()) as EvidencePage;
        if (valid())
          setData((old) => ({
            ...old,
            loading: false,
            error: false,
            evidence: merge(Array.isArray(page.evidence) ? page.evidence : [], old.evidence),
            // A refreshed head can leave a gap above cached pages, so traverse from its cursor.
            nextCursor: page.nextCursor,
          }));
      })
      .catch(() => {
        if (valid()) setData((old) => ({ ...old, loading: false, error: true }));
      })
      .finally(() => {
        if (valid()) headBusy.current = false;
      });
    return () => {
      if (valid()) generation.current++;
    };
  }, [incidentId, nonce, opts.apiBaseUrl, opts.getCredentials]);

  const loadDetail = useCallback(
    (id: string) => {
      if (cache.current[id] || inFlight.current.has(id)) return;
      const requests = inFlight.current;
      requests.add(id);
      setData((old) => ({
        ...old,
        details: { ...old.details, [id]: null },
        detailErrors: { ...old.detailErrors, [id]: false },
      }));
      const valid = () => identity.current === incidentId && requests === inFlight.current;
      void authenticatedFetch(
        `${opts.apiBaseUrl}/incidents/${incidentId}/evidence/${encodeURIComponent(id)}`,
        opts.getCredentials,
      )
        .then(async (res) => {
          if (!res.ok) throw new Error('Evidence unavailable');
          const detail = (await res.json()) as EvidenceDetail;
          if (valid()) {
            cache.current[id] = detail;
            setData((old) => ({ ...old, details: { ...old.details, [id]: detail } }));
          }
        })
        .catch(() => {
          if (valid())
            setData((old) => {
              const details = { ...old.details };
              delete details[id];
              return { ...old, details, detailErrors: { ...old.detailErrors, [id]: true } };
            });
        })
        .finally(() => requests.delete(id));
    },
    [incidentId, opts.apiBaseUrl, opts.getCredentials],
  );

  const loadOlder = useCallback(() => {
    if (!nextCursor || pageBusy.current || headBusy.current) return;
    pageBusy.current = true;
    const epoch = generation.current;
    const valid = () => identity.current === incidentId && epoch === generation.current;
    setData((old) => ({ ...old, loadingOlder: true, paginationError: false }));
    void authenticatedFetch(
      `${opts.apiBaseUrl}/incidents/${incidentId}/evidence?limit=20&before=${encodeURIComponent(nextCursor)}`,
      opts.getCredentials,
    )
      .then(async (res) => {
        if (!res.ok) throw new Error('Evidence unavailable');
        const page = (await res.json()) as EvidencePage;
        if (valid()) {
          setData((old) => ({
            ...old,
            evidence: merge(old.evidence, page.evidence),
            nextCursor: page.nextCursor,
            loadingOlder: false,
          }));
        }
      })
      .catch(() => {
        if (valid()) setData((old) => ({ ...old, loadingOlder: false, paginationError: true }));
      })
      .finally(() => {
        if (valid()) pageBusy.current = false;
      });
  }, [incidentId, nextCursor, opts.apiBaseUrl, opts.getCredentials]);

  return {
    ...data,
    evidence: current ? data.evidence : [],
    details: current ? data.details : {},
    detailErrors: current ? data.detailErrors : {},
    nextCursor,
    loading: !current || data.loading,
    loadDetail,
    loadOlder,
    refresh,
  };
}
