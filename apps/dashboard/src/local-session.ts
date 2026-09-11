// Local bearer sessions persist for this tab; retaining expiry metadata allows guarded renewal.
const SESSION_KEY = 'sre.localSession';
const RETURN_TO_KEY = 'sre.returnTo';

export interface LocalSession {
  token: string;
  expiresAt: number;
  email: string;
}

let cache: LocalSession | null | undefined;
let revision = 0;
const listeners = new Set<() => void>();

function store(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Storage access can throw outright under strict privacy settings.
    return null;
  }
}

function read(): LocalSession | null {
  const raw = store()?.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LocalSession>;
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.email !== 'string'
    ) {
      return null;
    }
    return { token: parsed.token, expiresAt: parsed.expiresAt, email: parsed.email };
  } catch {
    return null;
  }
}

/**
 * useSyncExternalStore snapshot: pure and referentially stable, so expiry is NOT evaluated here.
 * Callers derive freshness from `expiresAt` (useSession) or clear on use (getCredentials).
 */
export function getLocalSession(): LocalSession | null {
  if (cache === undefined) cache = read();
  return cache;
}

export function subscribeLocalSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function setLocalSession(next: LocalSession | null): void {
  revision++;
  cache = next;
  const s = store();
  if (s) {
    if (next) s.setItem(SESSION_KEY, JSON.stringify(next));
    else s.removeItem(SESSION_KEY);
  }
  for (const listener of listeners) listener();
}

/** Cancels stale sign-in and renewal responses when the session changes or signs out. */
export function localSessionRevision(): number {
  return revision;
}

/** Where to land after a sign-in that leaves the SPA for an OIDC provider. */
export function rememberReturnTo(path: string): void {
  store()?.setItem(RETURN_TO_KEY, path);
}

/** Reads the pending OIDC destination without consuming it during a failed callback. */
export function peekReturnTo(): string | null {
  return store()?.getItem(RETURN_TO_KEY) ?? null;
}

/** Read-and-clear: a stale return-to must not hijack a later navigation. */
export function takeReturnTo(): string | null {
  const s = store();
  const value = s?.getItem(RETURN_TO_KEY) ?? null;
  s?.removeItem(RETURN_TO_KEY);
  return value;
}

export interface LocalCapabilities {
  localPasswordLogin: boolean;
  localDevelopmentLogin: boolean;
}

let capabilities: Promise<LocalCapabilities> | undefined;

/**
 * Whether the API serves the local password path, from its public capability probe. Memoised for the
 * page lifetime: the answer is fixed at API boot, and every `useSession` consumer asks.
 */
export function localLoginCapabilities(apiBaseUrl: string): Promise<LocalCapabilities> {
  if (capabilities) return capabilities;
  let request: Promise<LocalCapabilities>;
  request = fetch(`${apiBaseUrl}/auth/capabilities`)
    .then(async (res) => {
      if (!res.ok) throw new Error(`local login capability probe rejected (${res.status})`);
      const body = (await res.json()) as Partial<LocalCapabilities>;
      return {
        localPasswordLogin: body.localPasswordLogin === true,
        localDevelopmentLogin: body.localDevelopmentLogin === true,
      };
    })
    .catch((error) => {
      // API and Vite start concurrently in development. Do not turn one transient startup failure into
      // a page-lifetime false result; the next probe must be allowed to reach the now-ready API.
      if (capabilities === request) capabilities = undefined;
      throw error;
    });
  capabilities = request;
  return request;
}
