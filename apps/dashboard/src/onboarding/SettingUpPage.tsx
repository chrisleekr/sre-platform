import { credentialHeaders } from '../lib/request-credentials';
import { sessionFetch } from '../lib/session-fetch';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { messageForApiCode } from '../i18n/messages';
import { useMe } from '../lib/me-store';
import { clearWorkspaceDraft } from './draft';
import { fieldClass, primaryButton } from './shared';
import { clearSignInRetry } from '../lib/application-session';

export interface FoundingView {
  id: string;
  status: string;
  failureReason: string | null;
  slug?: string;
}

export function foundingPollDelay(attempt: number): number {
  return Math.min(30_000, 3_000 * 2 ** Math.max(0, attempt));
}

/** Shows durable provisioning progress and resumes polling after a page reload. */
export function SettingUpPage({
  founding: supplied,
  onRetry,
}: {
  founding?: FoundingView;
  onRetry?: () => void;
}) {
  const session = useSession();
  const navigate = useNavigate();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  const [founding, setFounding] = useState(supplied);
  const [retryError, setRetryError] = useState<string>();
  const [pollError, setPollError] = useState<string>();
  const [lastChecked, setLastChecked] = useState<Date>();
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [editingAddress, setEditingAddress] = useState(false);
  const [retrySlug, setRetrySlug] = useState(supplied?.slug ?? '');
  const persistedFounding = me.data?.founding;
  const foundingId = session.foundingId ?? persistedFounding?.id;
  const getCredentials = session.getCredentials;
  const logout = session.logout;
  useEffect(() => {
    const restored =
      supplied ??
      (persistedFounding
        ? {
            id: persistedFounding.id,
            status: persistedFounding.status,
            failureReason: persistedFounding.failureReason ?? null,
            slug: persistedFounding.slug,
          }
        : undefined);
    setFounding(restored);
    if (restored?.slug) setRetrySlug(restored.slug);
  }, [persistedFounding, supplied]);
  useEffect(() => {
    if ((supplied && retryGeneration === 0) || !foundingId) return;
    let live = true;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      try {
        const token = await getCredentials();
        const response = await sessionFetch(`${config.apiBaseUrl}/foundings/${foundingId}`, {
          headers: { ...credentialHeaders(token) },
        });
        if (response.status === 401) {
          if (live)
            navigate('/sign-in', {
              replace: true,
              state: {
                from: '/get-started',
                error: 'Your sign-in expired. Sign in again to resume this workspace setup.',
              },
            });
          return;
        }
        if (!response.ok) throw new Error('Setup status is unavailable');
        const body = (await response.json()) as { founding: FoundingView };
        if (!live) return;
        setPollError(undefined);
        setLastChecked(new Date());
        setFounding(body.founding);
        if (body.founding.status === 'active') {
          clearWorkspaceDraft();
          clearSignInRetry();
          me.refresh();
          navigate('/w', { replace: true });
          return;
        }
        if (
          body.founding.status === 'failed' ||
          body.founding.status === 'rejected' ||
          body.founding.status === 'expired'
        )
          return;
        attempt += 1;
        timer = setTimeout(() => void poll(), foundingPollDelay(attempt));
      } catch {
        if (live) {
          setPollError(
            'We could not check setup progress. Your saved request is unchanged. Retrying automatically.',
          );
          attempt += 1;
          timer = setTimeout(() => void poll(), foundingPollDelay(attempt));
        }
      }
    };
    void poll();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [foundingId, getCredentials, logout, me.refresh, navigate, retryGeneration, supplied]);

  const status = founding?.status;
  const startAgain = () => {
    clearWorkspaceDraft();
    clearSignInRetry();
    const destination = '/get-started?setup=ended';
    logout(`${window.location.origin}${destination}`);
    navigate(destination, { replace: true });
  };
  const retry = async (): Promise<void> => {
    if (onRetry) {
      onRetry();
      return;
    }
    const slug = retrySlug.trim().toLowerCase();
    if (!foundingId || !slug) {
      setRetryError('Enter a workspace address before retrying setup.');
      return;
    }
    setRetryError(undefined);
    try {
      const token = await getCredentials();
      const response = await sessionFetch(`${config.apiBaseUrl}/foundings/${foundingId}/retry`, {
        method: 'POST',
        headers: { ...credentialHeaders(token), 'content-type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const body = (await response.json().catch(() => null)) as {
        founding?: FoundingView;
        code?: string;
      } | null;
      if (!response.ok || !body?.founding) {
        throw new Error(body?.code ? messageForApiCode(body.code) : 'Setup could not be retried.');
      }
      setFounding({ ...body.founding, slug: body.founding.slug ?? slug });
      setEditingAddress(false);
      setRetryGeneration((value) => value + 1);
    } catch (cause) {
      setRetryError(cause instanceof Error ? cause.message : 'Setup could not be retried.');
    }
  };
  return (
    <>
      {pollError && (
        <p role="alert" className="mb-4 rounded-lg bg-warning-soft p-3 text-sm text-warning">
          {pollError}
        </p>
      )}
      {lastChecked && (
        <p className="mb-4 text-xs text-ink-muted">
          Last checked {lastChecked.toLocaleTimeString()}
        </p>
      )}
      {status === 'pending' && <p role="status">Waiting for approval.</p>}
      {(status === 'approved' || status === 'provisioning' || !status) && (
        <p role="status">Setup is in progress.</p>
      )}
      {status === 'failed' && (
        <div>
          <p role="alert">Setup failed: {founding?.failureReason ?? 'Try again.'}</p>
          {retryError && <p role="alert">{retryError}</p>}
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="sre-action" onClick={() => setEditingAddress(true)}>
              Change address
            </button>
            <button type="button" className={primaryButton} onClick={() => void retry()}>
              Retry setup
            </button>
          </div>
          {editingAddress && (
            <div className="mt-4">
              <label htmlFor="retry-workspace-address" className="text-sm font-medium">
                Workspace address
              </label>
              <input
                id="retry-workspace-address"
                className={fieldClass}
                required
                value={retrySlug}
                onChange={(event) => {
                  setRetrySlug(event.target.value.toLowerCase());
                  setRetryError(undefined);
                }}
              />
            </div>
          )}
        </div>
      )}
      {status === 'rejected' && (
        <div className="space-y-4">
          <p role="alert" className="font-semibold text-warning">
            Workspace request declined.
          </p>
          <p className="text-sm text-ink-muted">
            {founding?.failureReason ?? 'Ask your platform administrator for details.'}
          </p>
          <button type="button" className={primaryButton} onClick={startAgain}>
            Start a new setup
          </button>
        </div>
      )}
      {status === 'expired' && (
        <div>
          <p role="alert">This setup request expired. Start again to create a new request.</p>
          <button type="button" className={`${primaryButton} mt-4`} onClick={startAgain}>
            Start again
          </button>
        </div>
      )}
    </>
  );
}
