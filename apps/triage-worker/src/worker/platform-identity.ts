import type { IDataSourceConnector } from '@sre/connectors';

// Logins change only when an operator swaps a credential, which bumps the connection generation.
const TTL_MS = 60 * 60_000;
// A provider that cannot answer is asked again later, not on every run while it is down.
const FAILURE_TTL_MS = 5 * 60_000;
// The login is a hint for the model; it must never hold an investigation up for long.
const LOOKUP_BUDGET_MS = 2_000;
// Provider logins are simple identifiers; anything else is refused rather than quoted to the model.
const LOGIN = /^[\w.@:+-]{1,128}$/;
// Keyed by connection id so a new generation replaces its predecessor, and concurrent runs share
// one in-flight lookup.
const cache = new Map<
  string,
  { version: number; at: number; ttl: number; login: Promise<string | null> }
>();

function lookup(connector: IDataSourceConnector, signal: AbortSignal): Promise<string | null> {
  const bound = AbortSignal.any([signal, AbortSignal.timeout(LOOKUP_BUDGET_MS)]);
  return Promise.race([
    Promise.resolve().then(() => connector.identity!()),
    new Promise<never>((_, reject) => {
      if (bound.aborted) reject(bound.reason);
      bound.addEventListener('abort', () => reject(bound.reason), { once: true });
    }),
  ]).then((login) => (login && LOGIN.test(login) ? login : null));
}

function loginFor(
  connector: IDataSourceConnector,
  now: number,
  signal: AbortSignal,
): Promise<string | null> {
  const version = connector.generation?.lifecycleVersion;
  // Without a generation a credential swap would not change the key, so never cache.
  if (version === undefined) return lookup(connector, signal).catch(() => null);
  const hit = cache.get(connector.id);
  if (hit && hit.version === version && now - hit.at < hit.ttl) return hit.login;
  const entry = { version, at: now, ttl: TTL_MS, login: lookup(connector, signal) };
  entry.login = entry.login.catch(() => {
    // The run's own deadline is not a provider failure, so it leaves nothing cached.
    if (signal.aborted) cache.delete(connector.id);
    else {
      entry.ttl = FAILURE_TTL_MS;
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'platform_identity.lookup_failed',
          connectorId: connector.id,
        }),
      );
    }
    return null;
  });
  cache.set(connector.id, entry);
  return entry.login;
}

/**
 * Names the logins this platform's own connections authenticate as, so an investigation can
 * recognise its own requests in provider logs instead of asking responders to find an owner.
 *
 * @param connectors - The tenant's resolved connections for this run.
 * @param options - The run's abort signal and a clock for the cache.
 */
export async function platformIdentityContext(
  connectors: readonly IDataSourceConnector[],
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<string> {
  const signal = options.signal ?? new AbortController().signal;
  const now = options.now ?? Date.now();
  const lines = await Promise.all(
    connectors
      .filter((connector) => connector.identity)
      .map(async (connector) => {
        const login = await loginFor(connector, now, signal);
        // JSON quoting keeps a tenant-edited name from closing the quote and adding claims.
        const name = JSON.stringify(connector.name.replace(/\s+/g, ' ').slice(0, 80));
        return login ? `- ${connector.type} connection ${name} authenticates as ${login}` : null;
      }),
  );
  const known = lines.filter((line): line is string => line !== null);
  if (known.length === 0) return '';
  return [
    "Platform identity: this platform's own requests (its investigation tools and background discovery) appear in provider logs under these logins. Other clients sharing the same service account log under them too, so confirm by request pattern before attributing load to the platform.",
    ...known,
  ].join('\n');
}

/** Clears the login cache between tests. */
export function resetPlatformIdentityCache(): void {
  cache.clear();
}
