import { credentialHeaders } from './request-credentials';
import type { CredentialGetter } from './request-credentials';
import { sessionFetch } from './session-fetch';
import { getLocalSession } from '../local-session';
import { reportSessionFailure } from '../session-failure';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { config } from '../config';
import {
  getImpersonationSession,
  impersonationHeaders,
  setImpersonationSession,
} from './impersonation';

export interface CurrentUserWorkspace {
  user: {
    id: string;
    email: string | null;
    isPlatformAdmin: boolean;
    pendingRegistrationCount?: number;
  };
  state:
    | 'active'
    | 'founding'
    | 'unaffiliated'
    | 'suspended'
    | 'deleting'
    | 'removed'
    | 'directory_unverified'
    | 'directory_required';
  tenant: {
    id: string;
    name: string;
    slug: string;
    status: string;
    role: 'owner' | 'admin' | 'member';
    founderOnly: boolean;
    impersonation?: {
      sessionId: string;
      reason: string;
      expiresAt: string;
    } | null;
  } | null;
  founding: {
    id: string;
    status: string;
    slug?: string;
    requestedName?: string;
    failureReason?: string | null;
    domain?: string | null;
    provider?: { id: string; displayName: string; issuer: string } | null;
  } | null;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
    status?: string;
    signInAvailable?: boolean;
    canSelect?: boolean;
  }>;
  welcome?: {
    workspaceCreated?: boolean;
    domainVerified?: boolean;
    observabilityConnected?: boolean;
    slackConnected?: boolean;
    shown?: boolean;
    dismissed: boolean;
    complete?: boolean;
  } | null;
  domain?: {
    id: string;
    domain: string;
    status: string;
    challengeHost: string;
    challengeValue: string | null;
    lastCheckedAt: string | null;
    foundingId: string | null;
  } | null;
}

interface Snapshot {
  sessionKey: string | null;
  data: CurrentUserWorkspace | null;
  loading: boolean;
  error: Error | null;
}

/** Error returned when the current-user projection cannot be loaded. */
export class WorkspaceStatusError extends Error {
  constructor(
    readonly status: number,
    message = `Workspace status failed with ${status}`,
  ) {
    super(message);
    this.name = 'WorkspaceStatusError';
  }
}

let snapshot: Snapshot = { sessionKey: null, data: null, loading: false, error: null };
let pending: { sessionKey: string; request: Promise<CurrentUserWorkspace> } | null = null;
let generation = 0;
const listeners = new Set<() => void>();
const REMEMBERED_WORKSPACE_KEY = 'sre-platform.remembered-workspace';

/** Removes the non-sensitive workspace shortcut when the current person signs out. */
export function clearRememberedWorkspace(): void {
  try {
    localStorage.removeItem(REMEMBERED_WORKSPACE_KEY);
  } catch {
    // Browser storage can be disabled independently of the authenticated session.
  }
}

function emit(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Loads the current-user projection once until an explicit invalidation. */
export function loadMe(
  fetcher: () => Promise<CurrentUserWorkspace>,
  sessionKey = 'test-session',
  revalidate = false,
): Promise<CurrentUserWorkspace> {
  if (snapshot.sessionKey !== sessionKey) {
    generation += 1;
    pending = null;
    emit({ sessionKey, data: null, loading: false, error: null });
  }
  if (pending?.sessionKey === sessionKey) return pending.request;
  if (snapshot.data && !revalidate) return Promise.resolve(snapshot.data);
  // Same-session revalidation must not unmount the authorized page and its unsaved forms.
  emit({ sessionKey, data: snapshot.data, loading: !snapshot.data, error: null });
  const requestGeneration = generation;
  const request = fetcher()
    .then((data) => {
      if (generation === requestGeneration && snapshot.sessionKey === sessionKey) {
        emit({ sessionKey, data, loading: false, error: null });
      }
      return data;
    })
    .catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error('Workspace status is unavailable');
      if (generation === requestGeneration && snapshot.sessionKey === sessionKey) {
        emit({ sessionKey, data: null, loading: false, error });
      }
      throw error;
    })
    .finally(() => {
      if (pending?.request === request) pending = null;
    });
  pending = { sessionKey, request };
  return request;
}

/** Invalidates current-user state after a mutation or session change. */
export function invalidateMe(sessionKey: string | null = snapshot.sessionKey): void {
  generation += 1;
  pending = null;
  emit({ sessionKey, data: null, loading: false, error: null });
}

/** Clears the module store between isolated tests. */
export function resetMeStoreForTests(): void {
  snapshot = { sessionKey: null, data: null, loading: false, error: null };
  pending = null;
  generation = 0;
  listeners.clear();
}

/** Selects the safe route implied by the server-authoritative workspace state. */
export function nextWorkspaceRoute(me: CurrentUserWorkspace): string {
  if (me.state === 'active') {
    return '/w';
  }
  if (me.state === 'founding') {
    return '/get-started';
  }
  if (me.state === 'suspended') return '/workspace-suspended';
  if (me.state === 'deleting') return '/workspace-deleting';
  if (me.state === 'removed') return '/workspace-removed';
  if (me.state === 'directory_unverified') return '/workspace-directory-unverified';
  if (me.state === 'directory_required') return '/workspace-directory-required';
  if (me.workspaces?.length) return '/w/select';
  if (me.user.isPlatformAdmin) return '/admin';
  return '/get-started';
}

async function fetchCurrentUser(
  getCredentials: CredentialGetter,
  foundingId?: string,
): Promise<CurrentUserWorkspace> {
  const token = await getCredentials();
  const supportSession = getImpersonationSession();
  let response = await sessionFetch(`${config.apiBaseUrl}/me`, {
    headers: {
      ...credentialHeaders(token),
      ...impersonationHeaders(),
      ...(foundingId ? { 'x-onboarding-founding-id': foundingId } : {}),
    },
  });
  if (response.status === 403 && supportSession) {
    setImpersonationSession(null);
    response = await sessionFetch(`${config.apiBaseUrl}/me`, {
      headers: {
        ...credentialHeaders(token),
        ...(foundingId ? { 'x-onboarding-founding-id': foundingId } : {}),
      },
    });
  }
  if (
    response.status === 401 &&
    token.kind === 'bearer' &&
    getLocalSession()?.token === token.token
  ) {
    reportSessionFailure('unauthorized');
  }
  if (!response.ok) throw new WorkspaceStatusError(response.status);
  return (await response.json()) as CurrentUserWorkspace;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React view over the session-scoped current-user projection. */
export function useMe(
  getCredentials: CredentialGetter,
  enabled = true,
  sessionKey?: string,
  foundingId?: string,
): Snapshot & { refresh(): void } {
  const getTokenRef = useRef(getCredentials);
  getTokenRef.current = getCredentials;
  const current = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  );
  const activeSessionKey = enabled ? sessionKey : undefined;
  const refresh = useCallback(() => {
    if (!activeSessionKey) return;
    invalidateMe(activeSessionKey);
    void loadMe(() => fetchCurrentUser(getTokenRef.current, foundingId), activeSessionKey).catch(
      () => undefined,
    );
  }, [activeSessionKey, foundingId]);
  useEffect(() => {
    if (!activeSessionKey) {
      if (snapshot.sessionKey !== null || snapshot.data || snapshot.loading || snapshot.error) {
        invalidateMe(null);
      }
      return;
    }
    void loadMe(() => fetchCurrentUser(getTokenRef.current, foundingId), activeSessionKey).catch(
      () => undefined,
    );
  }, [activeSessionKey, foundingId]);
  useEffect(() => {
    if (!activeSessionKey) return;
    const onFocus = (): void => {
      void loadMe(
        () => fetchCurrentUser(getTokenRef.current, foundingId),
        activeSessionKey,
        true,
      ).catch(() => undefined);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeSessionKey, foundingId]);
  return current.sessionKey === activeSessionKey
    ? { ...current, refresh }
    : {
        sessionKey: activeSessionKey ?? null,
        data: null,
        loading: Boolean(activeSessionKey),
        error: null,
        refresh,
      };
}
