import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  identityProviders,
  identityProviderDomains,
  memberships,
  tenantIdentityBindings,
  users,
  workspaceFoundings,
  type FoundingStatus,
  type ProviderScope,
} from './schema';

export interface PublicProvider {
  id: string;
  displayName: string;
  issuer: string;
  authorizationEndpoint: string | null;
  browserClientId: string | null;
  scope: ProviderScope;
  supportsSignup: boolean;
  authorizationScopes?: string[];
  authorizationAudience?: string | null;
}

export type IdentityProviderRow = typeof identityProviders.$inferSelect;

const ONBOARDING_FOUNDING_STATUSES: FoundingStatus[] = [
  'founder_authenticated',
  'pending',
  'approved',
  'provisioning',
  'active',
  'failed',
];

function browserCapableProvider() {
  return and(
    eq(identityProviders.status, 'active'),
    eq(identityProviders.kind, 'oidc'),
    isNotNull(identityProviders.authorizationEndpoint),
    isNotNull(identityProviders.browserClientId),
  );
}

function onboardingProvider() {
  return or(
    and(
      eq(identityProviders.status, 'provisional'),
      gt(identityProviders.expiresAt, sql`clock_timestamp()`),
    ),
    eq(identityProviders.status, 'pending_verification'),
  );
}

/**
 * Creates or returns the one development-only local provider.
 *
 * @param db - Administrator database connection.
 * @param input - Fixed local issuer and audience.
 */
export async function ensureLocalProvider(
  db: Db,
  input: { issuer: string; audience: string },
): Promise<string> {
  const existing = await db
    .select({
      id: identityProviders.id,
      kind: identityProviders.kind,
      scope: identityProviders.scope,
    })
    .from(identityProviders)
    .where(and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')))
    .limit(1);
  if (existing[0]) {
    if (existing[0].kind !== 'local' || existing[0].scope !== 'tenant') {
      throw new Error('local login issuer belongs to an incompatible active provider');
    }
    return existing[0].id;
  }
  const rows = await db
    .insert(identityProviders)
    .values({
      displayName: 'Local password',
      issuer: input.issuer,
      jwksUri: `${input.issuer}:jwks`,
      audience: input.audience,
      kind: 'local',
      scope: 'tenant',
      supportsSignup: false,
      emailClaim: 'email',
      tenantClaim: null,
      subjectClaim: 'sub',
      status: 'active',
    })
    .onConflictDoNothing()
    .returning({ id: identityProviders.id });
  if (rows[0]) return rows[0].id;
  const raced = await db
    .select({
      id: identityProviders.id,
      kind: identityProviders.kind,
      scope: identityProviders.scope,
    })
    .from(identityProviders)
    .where(and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')))
    .limit(1);
  if (!raced[0] || raced[0].kind !== 'local' || raced[0].scope !== 'tenant') {
    throw new Error('local provider insert conflict did not resolve to the local provider');
  }
  return raced[0].id;
}

/**
 * Lists active providers that a browser may use to start authentication.
 *
 * @param db - Database connection used for the operation.
 */
export function listPublicProviders(db: Db): Promise<PublicProvider[]> {
  return db
    .select({
      id: identityProviders.id,
      displayName: identityProviders.displayName,
      issuer: identityProviders.issuer,
      authorizationEndpoint: identityProviders.authorizationEndpoint,
      browserClientId: identityProviders.browserClientId,
      scope: identityProviders.scope,
      authorizationScopes: identityProviders.authorizationScopes,
      authorizationAudience: identityProviders.authorizationAudience,
      supportsSignup: identityProviders.supportsSignup,
    })
    .from(identityProviders)
    .where(browserCapableProvider())
    .orderBy(
      asc(identityProviders.sortOrder),
      asc(identityProviders.createdAt),
      asc(identityProviders.id),
    );
}

/**
 * Lists active providers used by identity verification.
 *
 * @param db - Database connection used for the operation.
 */
export function listActiveProviders(db: Db): Promise<IdentityProviderRow[]> {
  return db
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.status, 'active'))
    .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id));
}

/**
 * Returns the active provider for an issuer, or a live transitional row that prevents a stale miss.
 *
 * @param db - Database connection used for the operation.
 * @param issuer - Exact token issuer to inspect.
 */
export async function getProviderVerifierCandidateByIssuer(
  db: Db,
  issuer: string,
): Promise<IdentityProviderRow | null> {
  const candidates = await db
    .select()
    .from(identityProviders)
    .where(
      and(
        eq(identityProviders.issuer, issuer),
        or(eq(identityProviders.status, 'active'), onboardingProvider()),
      ),
    )
    .orderBy(
      sql`case when ${identityProviders.status} = 'active' then 0 else 1 end`,
      desc(identityProviders.updatedAt),
      desc(identityProviders.id),
    )
    .limit(2);
  const active = candidates.filter((provider) => provider.status === 'active');
  return active.length > 1 ? null : (candidates[0] ?? null);
}

/**
 * Returns one exact active OIDC provider for server-owned sign-in.
 *
 * @param db - Control-plane database connection.
 * @param providerId - Persisted provider selected by the browser.
 */
export async function getActiveOidcProviderById(
  db: Db,
  providerId: string,
): Promise<IdentityProviderRow | null> {
  const [provider] = await db
    .select()
    .from(identityProviders)
    .where(
      and(
        eq(identityProviders.id, providerId),
        eq(identityProviders.status, 'active'),
        eq(identityProviders.kind, 'oidc'),
      ),
    )
    .limit(1);
  return provider ?? null;
}

/**
 * Returns the provider usable by an in-progress founding or its pending domain verification.
 *
 * @param db - Database connection used for the operation.
 * @param foundingId - Workspace founding whose provider is requested.
 */
export async function getProviderForFounding(
  db: Db,
  foundingId: string,
): Promise<IdentityProviderRow | null> {
  const rows = await db
    .select({ provider: identityProviders })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(workspaceFoundings.providerId, identityProviders.id))
    .where(
      and(
        eq(workspaceFoundings.id, foundingId),
        inArray(workspaceFoundings.status, ONBOARDING_FOUNDING_STATUSES),
        onboardingProvider(),
      ),
    )
    .limit(1);
  return rows[0]?.provider ?? null;
}

export interface OnboardingProviderReference {
  foundingId: string;
  providerId: string;
}

/**
 * Confirms that a verified identity owns the exact live founding and non-active provider.
 *
 * @param db - Control-plane database connection.
 * @param input - Exact founding, provider, issuer, and verified subject to authorize.
 */
export async function isOnboardingFoundingOwner(
  db: Db,
  input: OnboardingProviderReference & { issuer: string; subject: string },
): Promise<boolean> {
  const [row] = await db
    .select({ id: workspaceFoundings.id })
    .from(workspaceFoundings)
    .innerJoin(identityProviders, eq(identityProviders.id, workspaceFoundings.providerId))
    .innerJoin(users, eq(users.id, workspaceFoundings.founderUserId))
    .where(
      and(
        eq(workspaceFoundings.id, input.foundingId),
        eq(identityProviders.id, input.providerId),
        eq(identityProviders.issuer, input.issuer),
        eq(users.issuer, input.issuer),
        eq(users.subject, input.subject),
        inArray(workspaceFoundings.status, ONBOARDING_FOUNDING_STATUSES),
        onboardingProvider(),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Persists the development-only local provider, binding, and owner role idempotently.
 *
 * @param db - Administrator connection used for local bootstrap control-plane writes.
 * @param input - Local provider identity and the provisioned user/tenant pair.
 */
export async function ensureLocalProviderBinding(
  db: Db,
  input: { issuer: string; audience: string; tenantId: string; userId: string },
): Promise<string> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select({
        id: identityProviders.id,
        kind: identityProviders.kind,
        scope: identityProviders.scope,
      })
      .from(identityProviders)
      .where(
        and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')),
      )
      .limit(1);
    const current = existing[0];
    if (current && (current.kind !== 'local' || current.scope !== 'tenant')) {
      throw new Error('local login issuer belongs to an incompatible active provider');
    }
    const providerId =
      current?.id ??
      (
        await tx
          .insert(identityProviders)
          .values({
            displayName: 'Local password',
            issuer: input.issuer,
            jwksUri: `${input.issuer}:jwks`,
            audience: input.audience,
            kind: 'local',
            scope: 'tenant',
            supportsSignup: false,
            emailClaim: 'email',
            tenantClaim: null,
            subjectClaim: 'sub',
            status: 'active',
          })
          .returning({ id: identityProviders.id })
      )[0]!.id;

    const binding = await tx
      .select({ tenantId: tenantIdentityBindings.tenantId })
      .from(tenantIdentityBindings)
      .where(
        and(
          eq(tenantIdentityBindings.providerId, providerId),
          isNull(tenantIdentityBindings.claimValue),
        ),
      )
      .limit(1);
    if (binding[0] && binding[0].tenantId !== input.tenantId) {
      throw new Error('local login provider is already bound to another tenant');
    }
    if (!binding[0]) {
      await tx
        .insert(tenantIdentityBindings)
        .values({ providerId, tenantId: input.tenantId, claimValue: null });
    }
    const updated = await tx
      .update(memberships)
      .set({ role: 'owner' })
      .where(and(eq(memberships.userId, input.userId), eq(memberships.tenantId, input.tenantId)))
      .returning({ userId: memberships.userId });
    if (!updated[0]) throw new Error('local login membership disappeared');
    return providerId;
  });
}

/**
 * Returns the tenant already bound to the development-only local provider.
 *
 * @param db - Administrator connection used for local bootstrap lookup.
 * @param issuer - Fixed local provider issuer.
 */
export async function getLocalProviderTenant(db: Db, issuer: string): Promise<string | null> {
  const rows = await db
    .select({ tenantId: tenantIdentityBindings.tenantId })
    .from(identityProviders)
    .innerJoin(tenantIdentityBindings, eq(tenantIdentityBindings.providerId, identityProviders.id))
    .where(
      and(
        eq(identityProviders.issuer, issuer),
        eq(identityProviders.kind, 'local'),
        eq(identityProviders.status, 'active'),
        isNull(tenantIdentityBindings.claimValue),
      ),
    )
    .limit(1);
  return rows[0]?.tenantId ?? null;
}

/**
 * Finds the active tenant directory whose verified domain exactly matches an email domain.
 *
 * @param db - Control-plane database connection.
 * @param domain - Normalized email domain to match.
 */
export async function findVerifiedDirectoryByDomain(
  db: Db,
  domain: string,
): Promise<PublicProvider | null> {
  const rows = await db
    .select({
      id: identityProviders.id,
      displayName: identityProviders.displayName,
      issuer: identityProviders.issuer,
      authorizationEndpoint: identityProviders.authorizationEndpoint,
      browserClientId: identityProviders.browserClientId,
      scope: identityProviders.scope,
      supportsSignup: identityProviders.supportsSignup,
      authorizationScopes: identityProviders.authorizationScopes,
      authorizationAudience: identityProviders.authorizationAudience,
    })
    .from(identityProviderDomains)
    .innerJoin(identityProviders, eq(identityProviders.id, identityProviderDomains.providerId))
    .where(
      and(
        sql`lower(${identityProviderDomains.domain}) = lower(${domain})`,
        eq(identityProviderDomains.status, 'verified'),
        browserCapableProvider(),
        eq(identityProviders.scope, 'tenant'),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Returns the first active installation provider that accepts new workspace founders.
 *
 * @param db - Control-plane database connection.
 */
export async function findSignupProvider(db: Db): Promise<PublicProvider | null> {
  const rows = await db
    .select({
      id: identityProviders.id,
      displayName: identityProviders.displayName,
      issuer: identityProviders.issuer,
      authorizationEndpoint: identityProviders.authorizationEndpoint,
      browserClientId: identityProviders.browserClientId,
      scope: identityProviders.scope,
      supportsSignup: identityProviders.supportsSignup,
      authorizationScopes: identityProviders.authorizationScopes,
      authorizationAudience: identityProviders.authorizationAudience,
    })
    .from(identityProviders)
    .where(
      and(
        browserCapableProvider(),
        eq(identityProviders.scope, 'installation'),
        eq(identityProviders.supportsSignup, true),
      ),
    )
    .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id))
    .limit(1);
  return rows[0] ?? null;
}
