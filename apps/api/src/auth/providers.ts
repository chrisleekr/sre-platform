import {
  createRemoteJWKSet,
  customFetch,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from 'jose';
import {
  getActiveOidcProviderById,
  getProviderVerifierCandidateByIssuer,
  getProviderForFounding,
  listActiveProviders,
  type Db,
  type IdentityProviderRow,
  type ProviderScope,
} from '@sre/db';

const DEFAULT_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 256;
const JWKS_FETCH_COOLDOWN_MS = 30_000;
const MAX_CONCURRENT_JWKS_FETCHES = 8;
const MAX_CONCURRENT_PROVIDER_LOOKUPS = 8;

export interface Verifier {
  providerId: string;
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
  emailClaim: string;
  subjectClaim: string;
  tenantClaim: string | null;
  scope: ProviderScope;
}

export interface BackchannelVerifier {
  id: string;
  issuer: string;
  browserClientId: string;
  typRequired: boolean;
  keys: JWTVerifyGetKey;
  enabled: true;
}

export interface ProviderVerifiers {
  byIssuer(issuer: string): Promise<Verifier | undefined>;
  forFounding(foundingId: string): Promise<Verifier | undefined>;
  byId?(providerId: string): Promise<BackchannelVerifier | undefined>;
  invalidate(): void;
}

export interface LocalVerifier {
  issuer: string;
  keys: JWTVerifyGetKey;
}

interface ResolverEntry {
  jwksUri: string;
  kind: IdentityProviderRow['kind'];
  localIssuer: string | null;
  keys: JWTVerifyGetKey;
}

interface ProviderSnapshot {
  generation: number;
  expiresAt: number;
  byIssuer: Map<string, IdentityProviderRow>;
}

interface VerifierEntry {
  fingerprint: string;
  verifier: Verifier;
}

interface ProviderLookupResult {
  checked: boolean;
  row: IdentityProviderRow | null;
}

/** Builds a bounded, refreshable verifier table from persisted provider rows. */
export function makeProviderVerifiers(
  db: Db,
  options: { ttlMs?: number; local?: LocalVerifier; remoteFetch?: FetchImplementation } = {},
): ProviderVerifiers {
  const ttlMs = Math.min(Math.max(options.ttlMs ?? DEFAULT_TTL_MS, 1), DEFAULT_TTL_MS);
  const resolvers = new Map<string, ResolverEntry>();
  const verifiers = new Map<string, VerifierEntry>();
  const nextJwksFetchAt = new Map<string, number>();
  const issuerLookups = new Map<string, Promise<ProviderLookupResult>>();
  const negativeIssuers = new Map<string, number>();
  let activeJwksFetches = 0;
  let activeProviderLookups = 0;
  let generation = 0;
  let snapshot: ProviderSnapshot | undefined;
  let inFlight: Promise<void> | undefined;

  const retain = <T>(cache: Map<string, T>, key: string, value: T): void => {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  };

  const guardedFetch = (row: IdentityProviderRow): FetchImplementation => {
    const fetchKey = `${row.id}:${row.jwksUri}`;
    return async (url, init) => {
      const now = Date.now();
      for (const [key, allowedAt] of nextJwksFetchAt) {
        if (allowedAt <= now) nextJwksFetchAt.delete(key);
      }
      if ((nextJwksFetchAt.get(fetchKey) ?? 0) > now) {
        throw new Error('JWKS fetch is cooling down');
      }
      if (activeJwksFetches >= MAX_CONCURRENT_JWKS_FETCHES) {
        throw new Error('JWKS fetch concurrency limit reached');
      }

      nextJwksFetchAt.set(fetchKey, now + JWKS_FETCH_COOLDOWN_MS);
      activeJwksFetches += 1;
      try {
        return await (options.remoteFetch ?? fetch)(url, init);
      } finally {
        activeJwksFetches -= 1;
      }
    };
  };

  const keysFor = (row: IdentityProviderRow): JWTVerifyGetKey | undefined => {
    const cached = resolvers.get(row.id);
    const localIssuer = row.kind === 'local' ? (options.local?.issuer ?? null) : null;
    if (
      cached?.jwksUri === row.jwksUri &&
      cached.kind === row.kind &&
      cached.localIssuer === localIssuer
    ) {
      retain(resolvers, row.id, cached);
      return cached.keys;
    }
    if (row.kind === 'local' && options.local?.issuer !== row.issuer) return undefined;
    const keys =
      row.kind === 'local'
        ? options.local!.keys
        : createRemoteJWKSet(new URL(row.jwksUri), {
            [customFetch]: guardedFetch(row),
          });
    retain(resolvers, row.id, { jwksUri: row.jwksUri, kind: row.kind, localIssuer, keys });
    return keys;
  };

  const project = (row: IdentityProviderRow): Verifier | undefined => {
    if (!row.audience) return undefined;
    const fingerprint = JSON.stringify([
      row.issuer,
      row.jwksUri,
      row.audience,
      row.kind,
      row.scope,
      row.emailClaim,
      row.subjectClaim,
      row.tenantClaim,
      row.kind === 'local' ? options.local?.issuer : null,
    ]);
    const cached = verifiers.get(row.id);
    if (cached?.fingerprint === fingerprint) {
      retain(verifiers, row.id, cached);
      return cached.verifier;
    }
    const keys = keysFor(row);
    if (!keys) return undefined;
    const verifier = {
      providerId: row.id,
      issuer: row.issuer,
      audience: row.audience,
      keys,
      emailClaim: row.emailClaim,
      subjectClaim: row.subjectClaim,
      tenantClaim: row.tenantClaim,
      scope: row.scope,
    };
    retain(verifiers, row.id, { fingerprint, verifier });
    return verifier;
  };

  const refresh = async (): Promise<Map<string, IdentityProviderRow>> => {
    for (;;) {
      if (snapshot?.generation === generation && snapshot.expiresAt > Date.now()) {
        return snapshot.byIssuer;
      }
      if (!inFlight) {
        const requestedGeneration = generation;
        inFlight = (async () => {
          const rows = await listActiveProviders(db);
          if (generation !== requestedGeneration) return;
          const counts = new Map<string, number>();
          for (const row of rows) counts.set(row.issuer, (counts.get(row.issuer) ?? 0) + 1);
          const byIssuer = new Map(
            rows.filter((row) => counts.get(row.issuer) === 1).map((row) => [row.issuer, row]),
          );
          snapshot = {
            generation: requestedGeneration,
            expiresAt: Date.now() + ttlMs,
            byIssuer,
          };
        })();
      }
      const pending = inFlight;
      try {
        await pending;
      } finally {
        if (inFlight === pending) inFlight = undefined;
      }
    }
  };

  const lookupIssuer = (issuer: string): Promise<ProviderLookupResult> => {
    const pending = issuerLookups.get(issuer);
    if (pending) return pending;
    if (activeProviderLookups >= MAX_CONCURRENT_PROVIDER_LOOKUPS) {
      return Promise.resolve({ checked: false, row: null });
    }
    activeProviderLookups += 1;
    const lookup = getProviderVerifierCandidateByIssuer(db, issuer)
      .then((row) => ({ checked: true, row }))
      .finally(() => {
        activeProviderLookups -= 1;
        if (issuerLookups.get(issuer) === lookup) issuerLookups.delete(issuer);
      });
    issuerLookups.set(issuer, lookup);
    return lookup;
  };

  return {
    async byId(providerId) {
      const row = await getActiveOidcProviderById(db, providerId);
      if (!row?.backchannelLogout || !row.browserClientId) return undefined;
      const keys = keysFor(row);
      return keys
        ? {
            id: row.id,
            issuer: row.issuer,
            browserClientId: row.browserClientId,
            typRequired: row.backchannelLogoutTypRequired,
            keys,
            enabled: true,
          }
        : undefined;
    },
    async byIssuer(issuer) {
      const active = await refresh();
      const cached = active.get(issuer);
      if (cached) return project(cached);
      const now = Date.now();
      if ((negativeIssuers.get(issuer) ?? 0) > now) return undefined;
      negativeIssuers.delete(issuer);
      const result = await lookupIssuer(issuer);
      if (!result.checked) return undefined;
      if (!result.row) {
        retain(negativeIssuers, issuer, now + ttlMs);
        return undefined;
      }
      if (result.row.status !== 'active') return undefined;
      negativeIssuers.delete(issuer);
      if (snapshot?.generation === generation) snapshot.byIssuer.set(issuer, result.row);
      return project(result.row);
    },
    async forFounding(foundingId) {
      const row = await getProviderForFounding(db, foundingId);
      if (row) negativeIssuers.delete(row.issuer);
      return row ? project(row) : undefined;
    },
    invalidate() {
      generation += 1;
      snapshot = undefined;
      negativeIssuers.clear();
    },
  };
}
