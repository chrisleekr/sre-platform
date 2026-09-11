import { createMiddleware } from 'hono/factory';
import { decodeJwt, jwtVerify, type JWTPayload } from 'jose';
import {
  getActiveAdminImpersonation,
  isOnboardingFoundingOwner,
  isPlatformAdminIdentity,
  type Db,
  type MembershipRole,
} from '@sre/db';
import type { Context } from 'hono';
import type { ProviderVerifiers } from './auth/providers';
import type { RevokePublisher } from './auth/revoke';
import type { PublicRateLimiter } from './onboarding/contracts';
import { resolveIdentityAccess } from './auth/identity-access';

export interface TenantContext {
  tenantId: string;
  issuer: string;
  sub: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  role: MembershipRole;
  founderOnly: boolean;
  impersonation?: {
    sessionId: string;
    reason: string;
    tenantName: string;
    expiresAt: Date;
  };
}

export interface UserContext {
  applicationSessionId?: string;
  userId: string;
  issuer: string;
  subject: string;
  email?: string;
  providerId: string;
  bindingClaimValue?: string | null;
  issuedAt: number;
  expiresAt: number;
}

type TenantAccessState =
  | 'unaffiliated'
  | 'suspended'
  | 'deleting'
  | 'removed'
  | 'directory_unverified'
  | 'directory_required';

export interface AuthDeps {
  browserSession?: (context: Context, foundingId?: string) => Promise<IdentityResolution>;
  verifiers: ProviderVerifiers;
  db: Db;
  adminDb: Db;
  settings: { get(key: 'MAX_TOKEN_LIFETIME_SEC'): Promise<number> };
  revoke: RevokePublisher;
  /** Allows the fail-closed development-only local provider to exercise administrator flows. */
  allowLocalPlatformAdmin?: boolean;
}

/** Identity context established by requireUser; tenant access may be unavailable. */
export type AuthVariables = {
  user: UserContext;
  tenant?: TenantContext;
  tenantAccessState?: TenantAccessState;
};

/** Tenant context established by authMiddleware for product routes. */
export type TenantAuthVariables = AuthVariables & { tenant: TenantContext };

export type TenantResolution =
  | { ok: true; tenant: TenantContext; scopes: string[] }
  | { ok: false; status: 401 | 403; error: string; state?: TenantAccessState | 'disabled' };

export type IdentityResolution =
  | {
      ok: true;
      user: UserContext;
      tenant?: TenantContext;
      tenantAccessState?: TenantAccessState;
      scopes: string[];
    }
  | {
      ok: false;
      status: 401 | 403;
      error: string;
      state?: 'disabled' | 'directory_unverified';
    };

async function applyImpersonation(
  deps: AuthDeps,
  resolution: IdentityResolution,
  sessionId: string | undefined,
): Promise<IdentityResolution> {
  if (!resolution.ok || !sessionId) return resolution;
  if (!FOUNDING_ID.test(sessionId)) {
    return { ok: false, status: 403, error: 'impersonation session unavailable' };
  }
  const allowed = await isPlatformAdminIdentity(deps.db, {
    userId: resolution.user.userId,
    providerId: resolution.user.providerId,
    allowLocal: deps.allowLocalPlatformAdmin,
  });
  const session = allowed
    ? await getActiveAdminImpersonation(deps.db, sessionId, resolution.user.userId)
    : null;
  if (!session) return { ok: false, status: 403, error: 'impersonation session unavailable' };
  return {
    ...resolution,
    tenant: {
      tenantId: session.tenantId,
      issuer: resolution.user.issuer,
      sub: resolution.user.subject,
      userId: resolution.user.userId,
      issuedAt: resolution.user.issuedAt,
      expiresAt: resolution.user.expiresAt,
      role: 'admin',
      founderOnly: false,
      impersonation: {
        sessionId: session.id,
        reason: session.reason,
        tenantName: session.tenantName,
        expiresAt: session.expiresAt,
      },
    },
    tenantAccessState: undefined,
  };
}

interface VerifiedIdentity {
  providerId: string;
  issuer: string;
  subject: string;
}

function normalized(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function verifiedEmail(payload: JWTPayload, emailClaim: string): string | undefined {
  const configured = normalized(payload[emailClaim]);
  if (emailClaim !== 'email' && configured) return configured;
  return payload.email_verified === true ? normalized(payload.email) : undefined;
}

function tokenScopes(payload: JWTPayload): string[] {
  if (typeof payload.scope === 'string') return payload.scope.split(/\s+/).filter(Boolean);
  return Array.isArray(payload.permissions)
    ? payload.permissions.filter((value): value is string => typeof value === 'string')
    : [];
}

const MAX_IAT_FUTURE_SKEW_SEC = 60;
const FOUNDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resolveIdentityFromToken(
  deps: AuthDeps,
  token: string | undefined,
  providerForIssuer: (
    issuer: string,
  ) => Promise<Awaited<ReturnType<ProviderVerifiers['byIssuer']>>> = (issuer) =>
    deps.verifiers.byIssuer(issuer),
  authorizeIdentity?: (identity: VerifiedIdentity) => Promise<boolean>,
): Promise<IdentityResolution> {
  if (!token) return { ok: false, status: 401, error: 'missing token' };

  let payload: JWTPayload;
  let verifier: Awaited<ReturnType<ProviderVerifiers['byIssuer']>>;
  try {
    const claimedIssuer = decodeJwt(token).iss;
    if (!claimedIssuer) return { ok: false, status: 401, error: 'invalid token' };
    verifier = await providerForIssuer(claimedIssuer);
    if (!verifier) return { ok: false, status: 401, error: 'invalid token' };
    ({ payload } = await jwtVerify(token, verifier.keys, {
      issuer: verifier.issuer,
      audience: verifier.audience,
    }));
  } catch {
    return { ok: false, status: 401, error: 'invalid token' };
  }

  const issuer = normalized(payload.iss);
  const baseSubject = normalized(payload.sub);
  if (!issuer || !baseSubject) {
    return { ok: false, status: 401, error: 'token missing iss or sub' };
  }
  const subject = normalized(payload[verifier.subjectClaim]) ?? baseSubject;
  const exp = payload.exp;
  const iat = payload.iat;
  if (
    typeof exp !== 'number' ||
    !Number.isFinite(exp) ||
    typeof iat !== 'number' ||
    !Number.isFinite(iat)
  ) {
    return { ok: false, status: 401, error: 'token missing exp or iat' };
  }
  if (iat >= exp || iat > Math.floor(Date.now() / 1_000) + MAX_IAT_FUTURE_SKEW_SEC) {
    return { ok: false, status: 401, error: 'invalid token' };
  }
  const maxLifetimeSec = await deps.settings.get('MAX_TOKEN_LIFETIME_SEC');
  if (exp - iat > maxLifetimeSec) {
    return {
      ok: false,
      status: 401,
      error: `token lifetime exceeds the platform maximum of ${maxLifetimeSec} seconds`,
    };
  }

  if (
    authorizeIdentity &&
    !(await authorizeIdentity({ providerId: verifier.providerId, issuer, subject }))
  ) {
    return { ok: false, status: 401, error: 'invalid token' };
  }

  return resolveIdentityAccess(deps, {
    providerId: verifier.providerId,
    issuer,
    subject,
    email: verifiedEmail(payload, verifier.emailClaim),
    emailVerified: verifier.emailClaim === 'email' && payload.email_verified === true,
    issuedAt: iat,
    expiresAt: exp,
    scope: verifier.scope,
    scopes: tokenScopes(payload),
    bindingClaimValue:
      verifier.scope === 'installation' && verifier.tenantClaim
        ? (normalized(payload[verifier.tenantClaim]) ?? null)
        : null,
  });
}

/** Verifies a bearer token and resolves a required tenant context. */
export async function resolveTenantFromToken(
  deps: AuthDeps,
  token: string | undefined,
): Promise<TenantResolution> {
  const resolution = await resolveIdentityFromToken(deps, token);
  if (!resolution.ok) return resolution;
  if (!resolution.tenant) {
    return {
      ok: false,
      status: 403,
      error: 'tenant access unavailable',
      state: resolution.tenantAccessState ?? 'unaffiliated',
    };
  }
  return { ok: true, tenant: resolution.tenant, scopes: resolution.scopes };
}

function bearerToken(header: string | undefined): string | undefined {
  return header?.startsWith('Bearer ') ? header.slice(7) : undefined;
}

/** Verifies identity and attaches optional tenant resolution state. */
export function requireUser(deps: AuthDeps) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const resolution = await applyImpersonation(
      deps,
      await (deps.browserSession && !bearerToken(c.req.header('authorization'))
        ? deps.browserSession(c)
        : resolveIdentityFromToken(deps, bearerToken(c.req.header('authorization')))),
      c.req.header('x-impersonation-session'),
    );
    if (!resolution.ok) {
      return c.json(
        { error: resolution.error, ...(resolution.state ? { state: resolution.state } : {}) },
        resolution.status,
      );
    }
    c.set('user', resolution.user);
    if (resolution.tenant) c.set('tenant', resolution.tenant);
    if (resolution.tenantAccessState) c.set('tenantAccessState', resolution.tenantAccessState);
    await next();
  });
}

export interface OnboardingAuthControls {
  limiter?: PublicRateLimiter;
  sourceAddress?: (c: Context) => string;
}

/** Allows a live founding's verified owner to use identity-first onboarding routes. */
export function requireOnboardingUser(deps: AuthDeps, controls: OnboardingAuthControls = {}) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const foundingSelector = c.req.header('x-onboarding-founding-id');
    if (foundingSelector && !FOUNDING_ID.test(foundingSelector)) {
      return c.json({ error: 'invalid token' }, 401);
    }
    if (foundingSelector) {
      try {
        if (!controls.limiter || !controls.sourceAddress) {
          return c.json({ error: 'onboarding authentication is unavailable' }, 503);
        }
        const source = controls.sourceAddress(c);
        if (!(await controls.limiter.allow('onboarding-resume-auth', source, 30, 60_000))) {
          return c.json({ error: 'too many onboarding requests' }, 429);
        }
      } catch {
        return c.json({ error: 'onboarding authentication is unavailable' }, 503);
      }
    }
    let restrictedProvider: { foundingId: string; providerId: string } | null = null;
    const resolution = await applyImpersonation(
      deps,
      await (deps.browserSession && !bearerToken(c.req.header('authorization'))
        ? deps.browserSession(c, foundingSelector)
        : resolveIdentityFromToken(
            deps,
            bearerToken(c.req.header('authorization')),
            async (issuer) => {
              const active = await deps.verifiers.byIssuer(issuer);
              if (active) return active;
              if (!foundingSelector) return undefined;
              const verifier = await deps.verifiers.forFounding(foundingSelector);
              if (verifier?.issuer !== issuer) {
                return undefined;
              }
              restrictedProvider = {
                foundingId: foundingSelector,
                providerId: verifier.providerId,
              };
              return verifier;
            },
            async ({ providerId, issuer, subject }) =>
              !restrictedProvider ||
              (restrictedProvider.providerId === providerId &&
                (await isOnboardingFoundingOwner(deps.db, {
                  ...restrictedProvider,
                  issuer,
                  subject,
                }))),
          )),
      c.req.header('x-impersonation-session'),
    );
    if (!resolution.ok) {
      return c.json(
        { error: resolution.error, ...(resolution.state ? { state: resolution.state } : {}) },
        resolution.status,
      );
    }
    c.set('user', resolution.user);
    if (resolution.tenant) c.set('tenant', resolution.tenant);
    if (resolution.tenantAccessState) c.set('tenantAccessState', resolution.tenantAccessState);
    await next();
  });
}

/** Accepts the founding provider before activation and ordinary active providers afterward. */
export function requireFoundingUser(deps: AuthDeps) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const foundingId = c.req.param('id');
    if (!foundingId) return c.json({ error: 'founding not found' }, 404);
    let restrictedProviderId: string | undefined;
    const resolution = await applyImpersonation(
      deps,
      await (deps.browserSession && !bearerToken(c.req.header('authorization'))
        ? deps.browserSession(c, foundingId)
        : resolveIdentityFromToken(
            deps,
            bearerToken(c.req.header('authorization')),
            async (issuer) => {
              const verifier = await deps.verifiers.forFounding(foundingId);
              if (verifier?.issuer === issuer) {
                restrictedProviderId = verifier.providerId;
                return verifier;
              }
              return deps.verifiers.byIssuer(issuer);
            },
            async ({ providerId, issuer, subject }) =>
              !restrictedProviderId ||
              (restrictedProviderId === providerId &&
                (await isOnboardingFoundingOwner(deps.db, {
                  foundingId,
                  providerId,
                  issuer,
                  subject,
                }))),
          )),
      c.req.header('x-impersonation-session'),
    );
    if (!resolution.ok) {
      return c.json(
        { error: resolution.error, ...(resolution.state ? { state: resolution.state } : {}) },
        resolution.status,
      );
    }
    c.set('user', resolution.user);
    if (resolution.tenant) c.set('tenant', resolution.tenant);
    if (resolution.tenantAccessState) c.set('tenantAccessState', resolution.tenantAccessState);
    await next();
  });
}

/** Requires the tenant context produced by requireUser. */
export function requireTenant() {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    if (!c.get('tenant')) {
      return c.json(
        {
          error: 'tenant access unavailable',
          state: c.get('tenantAccessState') ?? 'unaffiliated',
        },
        403,
      );
    }
    await next();
  });
}

/** Preserves the existing identity-plus-tenant composition for product routes. */
export function authMiddleware(deps: AuthDeps) {
  const identify = requireUser(deps);
  const authorizeTenant = requireTenant();
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    let identified = false;
    const refusal = await identify(c, async () => {
      identified = true;
    });
    return identified ? authorizeTenant(c, next) : refusal;
  });
}

/** Restricts identity-only routes to the platform administrator allowlist. */
export function requirePlatformAdmin(deps: AuthDeps) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const user = c.get('user');
    if (
      !user?.userId ||
      !(await isPlatformAdminIdentity(deps.db, {
        userId: user.userId,
        providerId: user.providerId,
        allowLocal: deps.allowLocalPlatformAdmin,
      }))
    ) {
      return c.json({ error: 'forbidden' }, 403);
    }
    await next();
  });
}
