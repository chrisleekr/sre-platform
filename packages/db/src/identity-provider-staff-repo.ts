import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import type { Executor } from './rls';
import { identityProviders, platformOperators, users } from './schema';

/**
 * Confirms that an operator is signed in through the installation provider or an armed local gate.
 *
 * @param db - Control-plane database connection.
 * @param input - User, authenticating provider, and optional local-development exception.
 */
export async function isPlatformAdminIdentity(
  db: Db,
  input: { userId: string; providerId: string; allowLocal?: boolean },
): Promise<boolean> {
  const rows = await db
    .select({ scope: identityProviders.scope, kind: identityProviders.kind })
    .from(platformOperators)
    .innerJoin(users, eq(users.id, platformOperators.userId))
    .innerJoin(
      identityProviders,
      and(
        eq(identityProviders.id, input.providerId),
        eq(identityProviders.issuer, users.issuer),
        eq(identityProviders.status, 'active'),
      ),
    )
    .where(eq(platformOperators.userId, input.userId))
    .limit(1);
  const provider = rows[0];
  return Boolean(
    provider &&
    (provider.scope === 'installation' || (input.allowLocal && provider.kind === 'local')),
  );
}

export interface StaffProviderInput {
  displayName: string;
  issuer: string;
  jwksUri?: string;
  audience?: string;
  clientAuthentication?: 'none' | 'client_secret_post' | 'client_secret_basic';
  emailClaim: string;
  browserClientId: string;
}

export interface StaffProviderMetadata {
  jwksUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

export interface StaffProviderResult {
  id: string;
  issuer: string;
  created: boolean;
}

/**
 * Returns the active staff provider, backfilling browser endpoints when an older row lacks them.
 *
 * @param db - Administrator database connection used for the operation.
 * @param input - Validated immutable staff-provider settings.
 * @param resolveMetadata - Discovers metadata for the issuer being inserted or backfilled.
 */
export async function ensureStaffProvider(
  db: Executor,
  input: StaffProviderInput,
  resolveMetadata: (issuer: string) => Promise<StaffProviderMetadata>,
): Promise<StaffProviderResult> {
  const existing = await db
    .select({
      id: identityProviders.id,
      issuer: identityProviders.issuer,
      authorizationEndpoint: identityProviders.authorizationEndpoint,
      tokenEndpoint: identityProviders.tokenEndpoint,
    })
    .from(identityProviders)
    .where(
      and(
        eq(identityProviders.status, 'active'),
        eq(identityProviders.kind, 'oidc'),
        eq(identityProviders.scope, 'installation'),
        eq(identityProviders.supportsSignup, false),
        isNull(identityProviders.tenantClaim),
      ),
    )
    .orderBy(asc(identityProviders.createdAt), asc(identityProviders.id))
    .limit(2);
  if (existing.length > 1) {
    throw new Error(
      'multiple active installation staff providers exist; correct them before bootstrap',
    );
  }
  if (existing[0]) {
    const current = existing[0];
    if (!current.authorizationEndpoint || !current.tokenEndpoint) {
      const metadata = await resolveMetadata(current.issuer);
      await db
        .update(identityProviders)
        .set({
          authorizationEndpoint: current.authorizationEndpoint ?? metadata.authorizationEndpoint,
          tokenEndpoint: current.tokenEndpoint ?? metadata.tokenEndpoint,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(identityProviders.id, current.id),
            eq(identityProviders.status, 'active'),
            eq(identityProviders.scope, 'installation'),
          ),
        );
    }
    return { id: current.id, issuer: current.issuer, created: false };
  }

  const [sameIssuer] = await db
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')))
    .limit(1);
  if (sameIssuer) {
    throw new Error(
      'the configured issuer belongs to an active provider that is not an installation staff provider',
    );
  }

  const metadata = await resolveMetadata(input.issuer);
  const [inserted] = await db
    .insert(identityProviders)
    .values({
      displayName: input.displayName,
      issuer: input.issuer,
      jwksUri: input.jwksUri ?? metadata.jwksUri,
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      audience: input.audience ?? null,
      clientAuthentication: input.clientAuthentication ?? 'none',
      kind: 'oidc',
      scope: 'installation',
      supportsSignup: false,
      emailClaim: input.emailClaim,
      tenantClaim: null,
      browserClientId: input.browserClientId,
      status: 'active',
    })
    .returning({ id: identityProviders.id, issuer: identityProviders.issuer });
  if (!inserted) throw new Error('staff provider insert returned no row');
  return { ...inserted, created: true };
}
