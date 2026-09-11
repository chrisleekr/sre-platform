import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'sre-platform.impersonation';
const EVENT = 'sre-platform:impersonation';
let cachedRaw: string | null | undefined;
let cachedSession: ImpersonationSession | null = null;

export interface ImpersonationSession {
  id: string;
  tenantId: string;
  tenantName: string;
  reason: string;
  expiresAt: string;
}

function parse(value: string | null): ImpersonationSession | null {
  if (!value) return null;
  try {
    const session = JSON.parse(value) as Record<string, unknown>;
    if (
      typeof session.id !== 'string' ||
      typeof session.tenantId !== 'string' ||
      typeof session.tenantName !== 'string' ||
      typeof session.reason !== 'string' ||
      typeof session.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(session.expiresAt)) ||
      Date.parse(session.expiresAt) <= Date.now()
    ) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session as unknown as ImpersonationSession;
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/** Returns the active client transport hint; the API remains the authority. */
export function getImpersonationSession(): ImpersonationSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw === cachedRaw) return cachedSession;
    cachedRaw = raw;
    cachedSession = parse(raw);
    return cachedSession;
  } catch {
    return null;
  }
}

/** Persists or clears the support-session transport hint for this browser tab. */
export function setImpersonationSession(session: ImpersonationSession | null): void {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } finally {
    cachedRaw = undefined;
    cachedSession = null;
    window.dispatchEvent(new Event(EVENT));
  }
}

/** Adds the active support-session header to an authenticated API request. */
export function impersonationHeaders(): Record<string, string> {
  const session = getImpersonationSession();
  return session ? { 'x-impersonation-session': session.id } : {};
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** React view over the browser-tab support session. */
export function useImpersonationSession(): ImpersonationSession | null {
  return useSyncExternalStore(subscribe, getImpersonationSession, () => null);
}
