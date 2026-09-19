import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { config } from './config';
import { useApplicationSession } from './lib/application-session';
import {
  getLocalSession,
  localLoginCapabilities,
  setLocalSession,
  subscribeLocalSession,
} from './local-session';
import { renewLocalDevelopmentSession } from './local-development-session';
import { clearSessionFailure, getSessionFailure, subscribeSessionFailure } from './session-failure';
import { SkeletonBlock } from './components/LoadingSkeleton';

/** Restore existing development sessions without changing the normal email-first entry flow. */
export function LocalDevelopmentSession({ children }: { children: ReactNode }) {
  const oidc = useApplicationSession();
  const local = useSyncExternalStore(subscribeLocalSession, getLocalSession, () => null);
  const failure = useSyncExternalStore(subscribeSessionFailure, getSessionFailure, () => null);
  const [enabled, setEnabled] = useState<boolean>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const recoveredAt = useRef(0);
  const hasLocal = Boolean(local);

  useEffect(() => {
    if (!hasLocal || oidc.isAuthenticated) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const probe = () => {
      void localLoginCapabilities(config.apiBaseUrl)
        .then((caps) => {
          if (live) {
            setEnabled(caps.localDevelopmentLogin);
            setError(undefined);
          }
        })
        .catch(() => {
          if (live) {
            setError(
              'Waiting for the local API. Start bun run dev; this page will retry automatically.',
            );
            timer = setTimeout(probe, 2_000);
          }
        });
    };
    probe();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hasLocal, oidc.isAuthenticated]);

  useEffect(() => {
    if (!enabled || !local || oidc.isLoading || oidc.isAuthenticated) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const renew = () => {
      if (failure && Date.now() - recoveredAt.current < 30_000) {
        setError(
          'The API rejected the renewed session. Check the API logs, then retry or sign in again.',
        );
        return;
      }
      if (failure) recoveredAt.current = Date.now();
      void renewLocalDevelopmentSession(config.apiBaseUrl)
        .then(() => {
          if (live) setError(undefined);
        })
        .catch((cause: unknown) => {
          if (!live) return;
          if (failure) recoveredAt.current = 0;
          setError(cause instanceof Error ? cause.message : 'Development session unavailable.');
          timer = setTimeout(renew, 2_000);
        });
    };
    const remaining = local.expiresAt - Date.now();
    timer = setTimeout(
      renew,
      failure ? 0 : Math.max(0, remaining - Math.min(30_000, remaining / 2)),
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [enabled, local, oidc.isLoading, oidc.isAuthenticated, failure, retry]);

  const waiting =
    local &&
    !oidc.isAuthenticated &&
    (enabled === undefined || (enabled && (failure || local.expiresAt <= Date.now())));
  if (!waiting) return children;
  return (
    <main className="min-h-dvh bg-canvas p-6 text-ink">
      <section className="mx-auto max-w-lg rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-medium">Reconnecting to your workspace</h1>
        <p role="status" className="mt-2 text-sm text-ink-muted">
          {error ?? 'Restoring your development session.'}
        </p>
        <SkeletonBlock className="mt-5 h-4 w-3/4" />
        <SkeletonBlock className="mt-3 h-4 w-1/2" />
        <div className="mt-5 flex gap-4 text-sm text-info">
          {error && (
            <button
              onClick={() => {
                recoveredAt.current = 0;
                setRetry((n) => n + 1);
              }}
            >
              Retry now
            </button>
          )}
          <button
            onClick={() => {
              setLocalSession(null);
              clearSessionFailure();
            }}
          >
            Back to sign in
          </button>
        </div>
      </section>
    </main>
  );
}
