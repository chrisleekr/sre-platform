import {
  getLocalSession,
  localLoginCapabilities,
  localSessionRevision,
  setLocalSession,
  type LocalSession,
} from './local-session';
import { clearSessionFailure, getSessionFailure } from './session-failure';
import { invalidateMe } from './lib/me-store';

let pending: { revision: number; request: Promise<boolean> } | undefined;

/** Only the guarded server can match an email to the configured development account. */
async function requestSession(
  apiBaseUrl: string,
  email: string,
  signal?: AbortSignal,
): Promise<LocalSession | null> {
  const response = await fetch(`${apiBaseUrl}/auth/local/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sre-local-development': 'true' },
    body: JSON.stringify({ email }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Development sign-in unavailable (${response.status}).`);
  const body = (await response.json()) as Partial<LocalSession> & { matched?: boolean };
  if (body.matched === false) return null;
  if (
    typeof body.token !== 'string' ||
    typeof body.email !== 'string' ||
    typeof body.expiresAt !== 'number' ||
    body.expiresAt <= Date.now()
  ) {
    throw new Error('Development sign-in returned an invalid session.');
  }
  return { token: body.token, email: body.email, expiresAt: body.expiresAt };
}

/** Never restore a session after sign-out or a different sign-in changed its revision. */
function acceptSession(next: LocalSession | null, revision: number): boolean {
  if (!next || localSessionRevision() !== revision) return false;
  if (!getLocalSession() || getSessionFailure()) invalidateMe(null);
  clearSessionFailure();
  setLocalSession(next);
  return true;
}

/** Unmatched emails continue through ordinary company discovery. */
export async function signInLocalDevelopment(
  apiBaseUrl: string,
  email: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const revision = localSessionRevision();
  signal?.throwIfAborted();
  if (!(await localLoginCapabilities(apiBaseUrl)).localDevelopmentLogin) return false;
  signal?.throwIfAborted();
  const next = await requestSession(apiBaseUrl, email, signal);
  signal?.throwIfAborted();
  if (localSessionRevision() !== revision) throw new DOMException('Sign-in canceled', 'AbortError');
  return acceptSession(next, revision);
}

/** Renew only an existing local session; an empty tab must use the email form. */
export function renewLocalDevelopmentSession(apiBaseUrl: string): Promise<boolean> {
  const current = getLocalSession();
  if (!current) return Promise.resolve(false);
  const revision = localSessionRevision();
  if (pending?.revision === revision) return pending.request;
  const request = (async () => {
    if (!(await localLoginCapabilities(apiBaseUrl)).localDevelopmentLogin) return false;
    const next = await requestSession(apiBaseUrl, current.email);
    if (!next) throw new Error('The local development account changed. Sign in again.');
    return acceptSession(next, revision);
  })().finally(() => {
    if (pending?.request === request) pending = undefined;
  });
  pending = { revision, request };
  return request;
}
