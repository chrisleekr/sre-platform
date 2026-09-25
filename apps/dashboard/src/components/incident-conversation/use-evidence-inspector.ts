import { useEffect, useRef, useState } from 'react';

const INSPECTOR_ENTRY = { evidenceInspector: true };

function isPushedInspectorEntry() {
  return (
    (window.history.state as { evidenceInspector?: unknown } | null)?.evidenceInspector === true
  );
}

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
  // Keep the marker so Close still knows the current entry was pushed by openEvidence.
  const restoreHash = () => {
    if (window.location.hash.startsWith('#evidence-'))
      window.history.replaceState(
        window.history.state,
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
    // The component is keyed by incident and mounts closed, so only a deep link changes state here.
    // Closing unconditionally would undo an All evidence click that landed before this effect ran.
    if (window.location.hash.startsWith('#evidence-')) navigateEvidence();
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
      const url = `${window.location.pathname}${window.location.search}#evidence-${id}`;
      if (window.location.hash === `#evidence-${id}`) return;
      // One inspector session owns one history entry, so Back and Close both leave it in one step.
      if (inspectorOpen) window.history.replaceState(window.history.state, '', url);
      else window.history.pushState(INSPECTOR_ENTRY, '', url);
    },
    closeEvidence: () => {
      setOpen(false);
      setId(null);
      // Replacing a pushed entry would leave a dead Back step. A deep-linked entry has no page
      // behind it to return to, so it is rewritten in place.
      if (isPushedInspectorEntry()) window.history.back();
      else restoreHash();
    },
    showAllEvidence: () => {
      captureTrigger();
      setOpen(true);
      setId(null);
      restoreHash();
    },
  };
}
