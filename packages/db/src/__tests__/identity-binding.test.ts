import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  makeDb,
  memberships,
  resolveTenantByBinding,
  tenantIdentityBindings,
  tenantInvitations,
  tenants,
  upsertUserForSignIn,
  users,
  workspaceFoundings,
  type DbHandle,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const MARKER = `binding-test-${randomUUID()}`;

let admin: DbHandle;
let app: DbHandle;
const tenantIds = new Set<string>();
const providerIds = new Set<string>();
const userIds = new Set<string>();

async function addTenant(status: 'active' | 'suspended' = 'active'): Promise<string> {
  const id = randomUUID();
  tenantIds.add(id);
  await admin.db.insert(tenants).values({
    id,
    name: `${MARKER}-${id}`,
    slug: `${MARKER}-${id}`,
    status,
  });
  return id;
}

async function addProvider(
  scope: 'installation' | 'tenant',
  tenantClaim: string | null,
): Promise<{ id: string; issuer: string }> {
  const id = randomUUID();
  const issuer = `https://${id}.${MARKER}.invalid/`;
  providerIds.add(id);
  await admin.db.insert(identityProviders).values({
    id,
    displayName: `${MARKER}-${id}`,
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    audience: 'sre-api',
    kind: 'oidc',
    scope,
    supportsSignup: false,
    emailClaim: 'email',
    subjectClaim: 'sub',
    tenantClaim,
    status: 'active',
  });
  return { id, issuer };
}

async function addUser(issuer: string, email?: string): Promise<string> {
  const [row] = await admin.db
    .insert(users)
    .values({ issuer, subject: `${MARKER}-${randomUUID()}`, email })
    .returning({ id: users.id });
  userIds.add(row!.id);
  return row!.id;
}

async function bind(tenantId: string, providerId: string, claimValue: string | null) {
  await admin.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue });
}

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
});

afterEach(async () => {
  const tenantsForCase = [...tenantIds];
  const providersForCase = [...providerIds];
  const usersForCase = [...userIds];
  if (tenantsForCase.length) {
    await admin.db
      .delete(tenantInvitations)
      .where(inArray(tenantInvitations.tenantId, tenantsForCase));
    await admin.db.delete(memberships).where(inArray(memberships.tenantId, tenantsForCase));
    await admin.db
      .delete(workspaceFoundings)
      .where(inArray(workspaceFoundings.tenantId, tenantsForCase));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(inArray(tenantIdentityBindings.tenantId, tenantsForCase));
  }
  if (providersForCase.length) {
    await admin.db
      .delete(identityProviderDomains)
      .where(inArray(identityProviderDomains.providerId, providersForCase));
    await admin.db
      .delete(workspaceFoundings)
      .where(inArray(workspaceFoundings.providerId, providersForCase));
  }
  if (usersForCase.length) await admin.db.delete(users).where(inArray(users.id, usersForCase));
  if (providersForCase.length)
    await admin.db.delete(identityProviders).where(inArray(identityProviders.id, providersForCase));
  if (tenantsForCase.length)
    await admin.db.delete(tenants).where(inArray(tenants.id, tenantsForCase));
  tenantIds.clear();
  providerIds.clear();
  userIds.clear();
});

afterAll(async () => {
  if (app) await app.close();
  if (admin) await admin.close();
});

describe('tenant resolution by provider binding', () => {
  test('an installation claim selects one tenant for the same user and preserves each stored role', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const firstTenant = await addTenant();
    const secondTenant = await addTenant();
    await bind(firstTenant, provider.id, 'org-a');
    await bind(secondTenant, provider.id, 'org-b');
    const userId = await addUser(provider.issuer, `${MARKER}@example.invalid`);

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org-a',
        userId,
        invitationEmail: `${MARKER}@example.invalid`,
      }),
    ).resolves.toMatchObject({ status: 'ok', tenantId: firstTenant, role: 'member' });
    await admin.db
      .update(memberships)
      .set({ role: 'admin' })
      .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, firstTenant)));

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org-b',
        userId,
      }),
    ).resolves.toMatchObject({ status: 'ok', tenantId: secondTenant, role: 'member' });
    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org-a',
        userId,
      }),
    ).resolves.toMatchObject({ status: 'ok', tenantId: firstTenant, role: 'admin' });
    await expect(
      resolveTenantByBinding(app.db, { providerId: provider.id, claimValue: null, userId }),
    ).resolves.toEqual({ status: 'unaffiliated' });
  });

  test('a tenant-scoped provider resolves through its null-claim binding', async () => {
    const provider = await addProvider('tenant', null);
    const tenantId = await addTenant();
    const userId = await addUser(provider.issuer);
    await bind(tenantId, provider.id, null);
    await admin.db.insert(identityProviderDomains).values({
      providerId: provider.id,
      domain: `${randomUUID()}.example.invalid`,
      status: 'verified',
      verifiedAt: new Date(),
    });

    await expect(
      resolveTenantByBinding(app.db, { providerId: provider.id, claimValue: null, userId }),
    ).resolves.toMatchObject({ status: 'ok', tenantId, role: 'member' });
  });

  test('returns suspended before membership work and never resurrects a removed membership', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const suspendedTenant = await addTenant('suspended');
    const activeTenant = await addTenant();
    const removedEmail = `${MARKER}-removed@example.invalid`;
    const userId = await addUser(provider.issuer, removedEmail);
    await bind(suspendedTenant, provider.id, 'suspended');
    await bind(activeTenant, provider.id, 'removed');
    await admin.db.insert(memberships).values({
      tenantId: activeTenant,
      userId,
      role: 'admin',
      status: 'removed',
    });
    await admin.db.insert(tenantInvitations).values({
      tenantId: activeTenant,
      email: removedEmail,
      role: 'admin',
      invitedByUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'suspended',
        userId,
      }),
    ).resolves.toMatchObject({ status: 'suspended' });
    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'removed',
        userId,
        invitationEmail: removedEmail,
      }),
    ).resolves.toMatchObject({ status: 'removed' });
    expect(
      await admin.db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, activeTenant))),
    ).toEqual([{ role: 'admin', status: 'removed' }]);
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.tenantId, activeTenant)),
    ).toEqual([{ status: 'pending' }]);
  });

  test('an unverified tenant directory admits only its recorded founder', async () => {
    const provider = await addProvider('tenant', null);
    const tenantId = await addTenant();
    const founderId = await addUser(provider.issuer);
    const strangerId = await addUser(provider.issuer);
    await bind(tenantId, provider.id, null);
    await admin.db.insert(workspaceFoundings).values({
      path: 'own_directory',
      slug: `${MARKER}-${randomUUID()}`,
      requestedName: 'Unverified directory test',
      providerId: provider.id,
      founderUserId: founderId,
      tenantId,
      status: 'active',
    });

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: null,
        userId: founderId,
      }),
    ).resolves.toMatchObject({ status: 'ok', tenantId, founderOnly: true });
    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: null,
        userId: strangerId,
      }),
    ).resolves.toMatchObject({ status: 'directory_unverified' });
    expect(
      await admin.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.tenantId, tenantId)),
    ).toEqual([{ userId: founderId }]);
  });

  test('consumes valid invitations once and makes pending ambiguity unrepresentable', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const inviterId = await addUser(provider.issuer);
    const acceptedId = await addUser(provider.issuer, `${MARKER}-accepted@example.invalid`);
    const ambiguousId = await addUser(provider.issuer, `${MARKER}-ambiguous@example.invalid`);
    await bind(tenantId, provider.id, 'org');
    await admin.db.insert(tenantInvitations).values([
      {
        tenantId,
        email: `${MARKER}-accepted@example.invalid`,
        role: 'admin',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        tenantId,
        email: `${MARKER}-ambiguous@example.invalid`,
        role: 'admin',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    ]);
    await expect(
      admin.db.insert(tenantInvitations).values({
        tenantId,
        email: `${MARKER}-AMBIGUOUS@example.invalid`,
        role: 'member',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId: acceptedId,
        invitationEmail: `${MARKER}-accepted@example.invalid`,
      }),
    ).resolves.toMatchObject({ status: 'ok', role: 'admin' });
    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId: ambiguousId,
        invitationEmail: `${MARKER}-ambiguous@example.invalid`,
      }),
    ).resolves.toMatchObject({ status: 'ok', role: 'admin' });
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.email, `${MARKER}-accepted@example.invalid`)),
    ).toEqual([{ status: 'accepted' }]);
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.email, `${MARKER}-ambiguous@example.invalid`)),
    ).toEqual([{ status: 'accepted' }]);
  });

  test('does not consume wrong-email or expired invitations', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const inviterId = await addUser(provider.issuer);
    const wrongEmailUser = await addUser(provider.issuer, `${MARKER}-wrong-user@example.invalid`);
    const expiredEmail = `${MARKER}-expired@example.invalid`;
    const expiredUser = await addUser(provider.issuer, expiredEmail);
    await bind(tenantId, provider.id, 'org');
    await admin.db.insert(tenantInvitations).values([
      {
        tenantId,
        email: `${MARKER}-expected@example.invalid`,
        role: 'admin',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() + 60_000),
      },
      {
        tenantId,
        email: expiredEmail,
        role: 'admin',
        invitedByUserId: inviterId,
        expiresAt: new Date(Date.now() - 1_000),
      },
    ]);

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId: wrongEmailUser,
        invitationEmail: `${MARKER}-wrong-user@example.invalid`,
      }),
    ).resolves.toMatchObject({ status: 'ok', role: 'member' });
    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId: expiredUser,
        invitationEmail: expiredEmail,
      }),
    ).resolves.toMatchObject({ status: 'ok', role: 'member' });
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.tenantId, tenantId)),
    ).toEqual([{ status: 'pending' }, { status: 'pending' }]);
  });

  test('refuses installation-scoped sign-in when a workspace requires its directory', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const userId = await addUser(provider.issuer);
    await bind(tenantId, provider.id, 'org');
    await admin.db.update(tenants).set({ requireDirectory: true }).where(eq(tenants.id, tenantId));

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId,
      }),
    ).resolves.toEqual({ status: 'directory_required', tenantId });
  });

  test('applies one valid invitation to an existing active membership atomically', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const inviterId = await addUser(provider.issuer);
    const email = `${MARKER}-existing-member@example.invalid`;
    const userId = await addUser(provider.issuer, email);
    await bind(tenantId, provider.id, 'org');
    await admin.db.insert(memberships).values({ tenantId, userId, role: 'member' });
    await admin.db.insert(tenantInvitations).values({
      tenantId,
      email,
      role: 'admin',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId,
        invitationEmail: email,
      }),
    ).resolves.toMatchObject({ status: 'ok', role: 'admin' });
    expect(
      await admin.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId))),
    ).toEqual([{ role: 'admin' }]);
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.tenantId, tenantId)),
    ).toEqual([{ status: 'accepted' }]);
  });

  test('serializes matching-email and no-email resolution for the same user', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const inviterId = await addUser(provider.issuer);
    const email = `${MARKER}-same-user@example.invalid`;
    const userId = await addUser(provider.issuer, email);
    await bind(tenantId, provider.id, 'org');
    await admin.db.insert(tenantInvitations).values({
      tenantId,
      email,
      role: 'admin',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all([
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId,
      }),
      resolveTenantByBinding(app.db, {
        providerId: provider.id,
        claimValue: 'org',
        userId,
        invitationEmail: email,
      }),
    ]);
    expect(results.every((result) => result.status === 'ok')).toBe(true);
    expect(results.some((result) => result.status === 'ok' && result.role === 'admin')).toBe(true);
    expect(
      await admin.db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId))),
    ).toEqual([{ role: 'admin', status: 'active' }]);
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.tenantId, tenantId)),
    ).toEqual([{ status: 'accepted' }]);
  });

  test('concurrent consumers elevate exactly one user and accept the invitation once', async () => {
    const provider = await addProvider('installation', 'organization_id');
    const tenantId = await addTenant();
    const inviterId = await addUser(provider.issuer);
    const email = `${MARKER}-concurrent@example.invalid`;
    const firstUser = await addUser(provider.issuer, email);
    const secondUser = await addUser(provider.issuer, email);
    await bind(tenantId, provider.id, 'org');
    await admin.db.insert(tenantInvitations).values({
      tenantId,
      email,
      role: 'admin',
      invitedByUserId: inviterId,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const results = await Promise.all(
      [firstUser, secondUser].map((userId) =>
        resolveTenantByBinding(app.db, {
          providerId: provider.id,
          claimValue: 'org',
          userId,
          invitationEmail: email,
        }),
      ),
    );
    expect(
      results.map((result) => (result.status === 'ok' ? result.role : result.status)).sort(),
    ).toEqual(['admin', 'member']);
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.tenantId, tenantId)),
    ).toEqual([{ status: 'accepted' }]);
  });
});

describe('sign-in user gate persistence', () => {
  test('updates last_sign_in_at at most once per minute while returning lifecycle gates', async () => {
    const issuer = `https://${MARKER}.sign-in.invalid/`;
    const identity = { issuer, subject: randomUUID(), email: `${MARKER}@example.invalid` };
    const first = await upsertUserForSignIn(app.db, identity);
    userIds.add(first.userId);
    const [firstRow] = await admin.db
      .select({ lastSignInAt: users.lastSignInAt })
      .from(users)
      .where(eq(users.id, first.userId));
    expect(firstRow?.lastSignInAt).toBeInstanceOf(Date);

    await upsertUserForSignIn(app.db, identity);
    const [immediateRow] = await admin.db
      .select({ lastSignInAt: users.lastSignInAt })
      .from(users)
      .where(eq(users.id, first.userId));
    expect(immediateRow?.lastSignInAt?.getTime()).toBe(firstRow?.lastSignInAt?.getTime());

    const stale = new Date(Date.now() - 61_000);
    await admin.db.update(users).set({ lastSignInAt: stale }).where(eq(users.id, first.userId));
    await upsertUserForSignIn(app.db, identity);
    const [refreshed] = await admin.db
      .select({ lastSignInAt: users.lastSignInAt })
      .from(users)
      .where(eq(users.id, first.userId));
    expect(refreshed?.lastSignInAt?.getTime()).toBeGreaterThan(stale.getTime());
  });
});
