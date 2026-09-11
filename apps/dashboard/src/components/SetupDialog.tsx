import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { SetupDialogSlots } from './SetupDialogSlots';

export function SetupDialog({
  title,
  closeLabel,
  busy = false,
  returnFocusTo,
  onClose,
  children,
  size = 'wide',
}: {
  title: string;
  closeLabel: string;
  busy?: boolean;
  returnFocusTo?: HTMLElement | null;
  onClose: () => void;
  children: ReactNode;
  size?: 'compact' | 'standard' | 'wide';
}) {
  const [navigation, setNavigation] = useState<HTMLElement | null>(null);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const width = { compact: 'max-w-lg', standard: 'max-w-2xl', wide: 'max-w-6xl' }[size];
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const requestedReturnFocusRef = useRef(returnFocusTo);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const capturedReturnFocusRef = useRef(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!capturedReturnFocusRef.current) {
      const requestedReturnFocus = requestedReturnFocusRef.current;
      const active = document.activeElement;
      returnFocusRef.current =
        requestedReturnFocus?.isConnected === true
          ? requestedReturnFocus
          : active instanceof HTMLElement && active !== document.body && !dialog.contains(active)
            ? active
            : null;
      capturedReturnFocusRef.current = true;
    }
    dialog.showModal();
    titleRef.current?.focus();
    return () => {
      if (dialog.open) dialog.close();
      queueMicrotask(() => {
        const returnFocus = returnFocusRef.current;
        if (!dialog.open && returnFocus?.isConnected) returnFocus.focus();
      });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      className={`m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] ${width} overflow-hidden rounded-xl border border-line bg-surface p-0 text-sm text-ink shadow-xl backdrop:bg-scrim`}
    >
      <div className="flex max-h-[calc(100dvh-2rem-2px)] min-h-0 flex-col has-[nav]:h-[min(52rem,calc(100dvh-2rem-2px))]">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b border-line bg-surface px-4 py-3 sm:px-6">
          <h2 ref={titleRef} id={titleId} tabIndex={-1} className="font-semibold tracking-tight">
            {title}
          </h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            className="min-h-11 shrink-0 rounded border border-line-strong px-3 py-1.5 font-medium hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
          >
            {closeLabel}
          </button>
        </header>
        <div
          ref={setNavigation}
          className="shrink-0 border-b border-line bg-surface-subtle px-4 py-3 empty:hidden sm:px-6"
        />
        <SetupDialogSlots.Provider value={{ navigation, actions, body }}>
          <div
            ref={setBody}
            tabIndex={-1}
            data-dialog-body
            className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 [overflow-wrap:anywhere] focus:outline-none sm:p-6"
          >
            {children}
          </div>
        </SetupDialogSlots.Provider>
        <footer
          ref={setActions}
          className="shrink-0 border-t border-line bg-surface px-4 py-3 empty:hidden sm:px-6"
        />
      </div>
    </dialog>
  );
}
