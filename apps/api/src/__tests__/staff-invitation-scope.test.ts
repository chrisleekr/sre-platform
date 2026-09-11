import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  identityProviders,
  insertAdminInvitation,
  isPlatformAdminIdentity,
  makeDb,
  platformAdminInvitations,
  platformOperators,
  users,
  type DbHandle,
} from '@sre/db';
import { resolveIdentityAccess } from '../auth/identity-access';
import { makeProviderVerifiers } from '../auth/providers';
import type { AuthDeps } from '../auth';

let admin: DbHandle;
let app: DbHandle;
const issuer = `https://shared-${randomUUID()}.example.test`;
const tenantProvider = randomUUID();
const staffProvider = randomUUID();
const email = 'invited@company.example.test';
const createdUsers: string[] = [];

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  for (const [id, scope, clientId] of [
    [tenantProvider, 'tenant', 'tenant-client'],
    [staffProvider, 'installation', 'staff-client'],
  ] as const) {
    await admin.db.insert(identityProviders).values({
      id,
      displayName: clientId,
      issuer,
      jwksUri: `${issuer}/jwks`,
      browserClientId: clientId,
      audience: null,
      kind: 'oidc',
      scope,
      status: 'active',
    });
  }
  await insertAdminInvitation(admin.db, { issuer, email });
});
afterAll(async () => {
  for (const userId of createdUsers)
    await admin.db.delete(platformOperators).where(eq(platformOperators.userId, userId));
  await admin.db
    .delete(platformAdminInvitations)
    .where(eq(platformAdminInvitations.issuer, issuer));
  await admin.db.delete(users).where(eq(users.issuer, issuer));
  await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, issuer));
  await Promise.all([admin.close(), app.close()]);
});

test('a tenant-client sign-in cannot consume a staff invitation for the same verified email and issuer', async () => {
  const auth: AuthDeps = {
    db: app.db,
    adminDb: admin.db,
    verifiers: makeProviderVerifiers(app.db),
    settings: { get: async () => 86400 },
    revoke: { publish: async () => {} },
  };
  const pending = async () =>
    (
      await admin.db
        .select()
        .from(platformAdminInvitations)
        .where(
          and(
            eq(platformAdminInvitations.issuer, issuer),
            eq(platformAdminInvitations.email, email),
          ),
        )
    )[0]!;
  async function signIn(providerId: string, scope: 'tenant' | 'installation', subject: string) {
    const result = await resolveIdentityAccess(auth, {
      providerId,
      scope,
      issuer,
      subject,
      email,
      issuedAt: Date.now() / 1000,
      expiresAt: Date.now() / 1000 + 300,
      bindingClaimValue: null,
      scopes: [],
    });
    if (!result.ok) throw new Error('Fixture identity was unexpectedly rejected');
    createdUsers.push(result.user.userId);
    return result.user.userId;
  }
  const tenantUser = await signIn(tenantProvider, 'tenant', 'pairwise-tenant-subject');
  expect((await pending()).acceptedAt).toBeNull();
  expect(
    await isPlatformAdminIdentity(admin.db, { providerId: tenantProvider, userId: tenantUser }),
  ).toBe(false);
  const staffUser = await signIn(staffProvider, 'installation', 'pairwise-staff-subject');
  expect(staffUser).not.toBe(tenantUser);
  expect((await pending()).acceptedAt).not.toBeNull();
  expect(
    await isPlatformAdminIdentity(admin.db, { providerId: staffProvider, userId: staffUser }),
  ).toBe(true);
});
