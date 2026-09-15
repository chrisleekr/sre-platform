import { useEffect, useRef, useState } from 'react';

/** Keep explicit evidence navigation independent of live preview refreshes. */
export function useEvidenceInspector(incidentId: string, loadDetail: (id: string) => void) {
  const [inspectorOpen, setOpen] = useState(false);
  const [inspectorId, setId] = useState<string | null>(null);
  const [inspectorContext, setContext] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const previousHash = useRef('');
  const captureTrigger = () => {
    if (inspectorOpen) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    previousHash.current = window.location.hash.startsWith('#evidence-')
      ? ''
      : window.location.hash;
  };
  const restoreHash = () => {
    if (window.location.hash.startsWith('#evidence-'))
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}${window.location.search}${previousHash.current}`,
      );
  };
  useEffect(() => {
    const navigateEvidence = () => {
      const match =
        /^#evidence-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
          window.location.hash,
        );
      setOpen(Boolean(match));
      setId(match?.[1] ?? null);
      setContext(null);
      if (match) {
        if (!trigger.current?.isConnected) trigger.current = document.querySelector('h1');
        loadDetail(match[1]!);
      }
    };
    navigateEvidence();
    window.addEventListener('hashchange', navigateEvidence);
    window.addEventListener('popstate', navigateEvidence);
    return () => {
      window.removeEventListener('hashchange', navigateEvidence);
      window.removeEventListener('popstate', navigateEvidence);
    };
  }, [incidentId, loadDetail]);
  return {
    inspectorOpen,
    inspectorId,
    inspectorContext,
    evidenceTrigger: trigger.current,
    openEvidence: (id: string, context?: string) => {
      setContext(context ?? null);
      captureTrigger();
      setOpen(true);
      setId(id);
      loadDetail(id);
      if (window.location.hash !== `#evidence-${id}`)
        window.history.pushState(
          null,
          '',
          `${window.location.pathname}${window.location.search}#evidence-${id}`,
        );
    },
    closeEvidence: () => {
      setOpen(false);
      setId(null);
      restoreHash();
    },
    showAllEvidence: () => {
      captureTrigger();
      setOpen(true);
      setId(null);
      restoreHash();
    },
  };
}
