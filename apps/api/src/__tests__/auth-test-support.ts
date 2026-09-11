import { and, eq } from 'drizzle-orm';
import type { JWTVerifyGetKey } from 'jose';
import { identityProviders, tenantIdentityBindings, type Db } from '@sre/db';
import type { AuthDeps } from '../auth';

/** Adds a provider claim binding for a tenant created after its API fixture. */
export async function bindTestIdentity(input: {
  adminDb: Db;
  issuer: string;
  tenantId: string;
  subject: string;
}): Promise<void> {
  const providerRows = await input.adminDb
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')))
    .limit(1);
  const providerId = providerRows[0]?.id;
  if (!providerId) throw new Error('test provider does not exist');
  await input.adminDb
    .insert(tenantIdentityBindings)
    .values({ providerId, tenantId: input.tenantId, claimValue: input.subject })
    .onConflictDoNothing();
}

/** Installs an installation-scoped provider for an isolated API test fixture. */
export async function makeTestAuth(input: {
  adminDb: Db;
  appDb: Db;
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
  bindings: Array<{ tenantId: string; subject: string }>;
  emailClaim?: string;
}): Promise<AuthDeps> {
  await input.adminDb
    .insert(identityProviders)
    .values({
      displayName: `Test provider ${input.issuer}`,
      issuer: input.issuer,
      jwksUri: `${input.issuer.replace(/\/$/, '')}/jwks`,
      audience: input.audience,
      kind: 'oidc',
      scope: 'installation',
      supportsSignup: false,
      emailClaim: input.emailClaim ?? 'email',
      subjectClaim: 'sub',
      tenantClaim: 'sub',
      status: 'active',
    })
    .onConflictDoNothing();
  const providerRows = await input.adminDb
    .select({ id: identityProviders.id })
    .from(identityProviders)
    .where(and(eq(identityProviders.issuer, input.issuer), eq(identityProviders.status, 'active')))
    .limit(1);
  const providerId = providerRows[0]?.id;
  if (!providerId) throw new Error('test provider insert returned no row');
  for (const binding of input.bindings) {
    await input.adminDb
      .insert(tenantIdentityBindings)
      .values({ providerId, tenantId: binding.tenantId, claimValue: binding.subject })
      .onConflictDoNothing();
  }
  return {
    verifiers: {
      byIssuer: async (issuer) =>
        issuer === input.issuer
          ? {
              providerId,
              issuer: input.issuer,
              audience: input.audience,
              keys: input.keys,
              emailClaim: input.emailClaim ?? 'email',
              subjectClaim: 'sub',
              tenantClaim: 'sub',
              scope: 'installation',
            }
          : undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: input.appDb,
    adminDb: input.adminDb,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
}
