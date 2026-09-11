import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviders,
  identityProviderDomains,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenantInvitations,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../../app';
import type { AuthDeps } from '../../auth';
import type { Notifier } from '@sre/notifications';

const marker = randomUUID();
const issuer = `https://members-api-${marker}.invalid`;
const audience = 'sre-api';
const providerId = randomUUID();
const tenantId = randomUUID();
const identities = {
  ownerA: { id: randomUUID(), subject: 'owner-a' },
  ownerB: { id: randomUUID(), subject: 'owner-b' },
  admin: { id: randomUUID(), subject: 'admin' },
  member: { id: randomUUID(), subject: 'member' },
  removed: { id: randomUUID(), subject: 'removed' },
  transferTarget: { id: randomUUID(), subject: 'transfer-target' },
};
const publish = vi.fn<(message: { userId: string; tenantId?: string }) => Promise<void>>();
const notify = vi.fn<Notifier['notify']>(async () => undefined);
let admin: DbHandle;
let appDb: DbHandle;
let privateKey: CryptoKey;
let api: ReturnType<typeof makeApp>;

function sign(subject: string): Promise<string> {
  return new SignJWT({ sub: subject, email: `${subject}@example.test`, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'members-api' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'members-api';
  jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  await admin.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Members API',
    issuer,
    jwksUri: `${issuer}/jwks`,
    audience,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  await admin.db.insert(tenants).values({
    id: tenantId,
    name: 'Members API',
    slug: `members-api-${marker}`,
  });
  await admin.db
    .insert(identityProviderDomains)
    .values({ providerId, domain: 'example.test', status: 'verified' });
  await admin.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await admin.db.insert(users).values(
    Object.values(identities).map((identity) => ({
      id: identity.id,
      issuer,
      subject: identity.subject,
      email: `${identity.subject}@example.test`,
    })),
  );
  await admin.db.insert(memberships).values([
    { tenantId, userId: identities.ownerA.id, role: 'owner' },
    { tenantId, userId: identities.ownerB.id, role: 'owner' },
    { tenantId, userId: identities.admin.id, role: 'admin' },
    { tenantId, userId: identities.member.id, role: 'member' },
    { tenantId, userId: identities.removed.id, role: 'member', status: 'removed' },
    { tenantId, userId: identities.transferTarget.id, role: 'member' },
  ]);
  const auth: AuthDeps = {
    verifiers: {
      byIssuer: async (value) =>
        value === issuer
          ? {
              providerId,
              issuer,
              audience,
              keys,
              emailClaim: 'email',
              subjectClaim: 'sub',
              tenantClaim: null,
              scope: 'tenant',
            }
          : undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: appDb.db,
    adminDb: admin.db,
    settings: { get: async () => 86_400 },
    revoke: { publish },
  };
  api = makeApp({
    auth,
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets: makeSecretStore(appDb.db, Buffer.alloc(32, 9).toString('base64')),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    notifier: { notify },
  });
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  await admin.db.delete(tenantInvitations).where(eq(tenantInvitations.tenantId, tenantId));
  await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await admin.db
    .delete(tenantIdentityBindings)
    .where(eq(tenantIdentityBindings.tenantId, tenantId));
  await admin.db
    .delete(identityProviderDomains)
    .where(eq(identityProviderDomains.providerId, providerId));
  await admin.db.delete(users).where(eq(users.issuer, issuer));
  await admin.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), appDb.close()]);
});

describe('workspace member API', () => {
  test('enforces role policy, invitation uniqueness, last-owner safety, and tenant revocation', async () => {
    const ownerToken = await sign(identities.ownerA.subject);
    const adminToken = await sign(identities.admin.subject);
    const memberToken = await sign(identities.member.subject);

    const oversizedRole = await api.request(`/tenant/members/${identities.ownerB.id}/role`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${memberToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member', padding: 'x'.repeat(5 * 1024) }),
    });
    expect(oversizedRole.status).toBe(413);
    expect(
      await admin.db
        .select({ role: memberships.role })
        .from(memberships)
        .where(
          and(eq(memberships.tenantId, tenantId), eq(memberships.userId, identities.ownerB.id)),
        ),
    ).toEqual([{ role: 'owner' }]);

    const oversizedInvitation = await api.request('/tenant/invitations', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${'x'.repeat(5 * 1024)}@example.test`, role: 'member' }),
    });
    expect(oversizedInvitation.status).toBe(413);

    const invitationBody = JSON.stringify({
      email: `Invite-${marker}@Example.Test`,
      role: 'admin',
    });
    const invite = await api.request('/tenant/invitations', {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: invitationBody,
    });
    expect(invite.status).toBe(201);
    const invitation = ((await invite.json()) as { invitation: { id: string; email: string } })
      .invitation;
    expect(invitation.email).toBe(`invite-${marker}@example.test`);
    expect(notify).toHaveBeenCalledWith(
      { email: `invite-${marker}@example.test` },
      'invitation.created',
      { workspaceName: 'Members API', role: 'admin' },
      { tenantId, eventKey: `invitation:${invitation.id}:created` },
    );
    expect(
      (
        await api.request('/tenant/invitations', {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ email: `INVITE-${marker}@EXAMPLE.TEST`, role: 'member' }),
        })
      ).status,
    ).toBe(409);

    const activeMemberRead = await api.request('/tenant/members', {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(activeMemberRead.status).toBe(200);
    const activeMemberDirectory = (await activeMemberRead.json()) as {
      members: Record<string, unknown>[];
      invitations?: unknown;
    };
    expect(activeMemberDirectory.members.map((entry) => entry.userId)).toContain(
      identities.member.id,
    );
    expect(activeMemberDirectory.members.map((entry) => entry.userId)).not.toContain(
      identities.removed.id,
    );
    expect(
      activeMemberDirectory.members.every(
        (entry) => Object.keys(entry).sort().join(',') === 'email,role,userId',
      ),
    ).toBe(true);
    expect(activeMemberDirectory).not.toHaveProperty('invitations');

    expect(
      (
        await api.request(`/tenant/invitations/${invitation.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(200);
    const invitedToken = await sign(`invite-${marker}`);
    const invitedMe = await api.request('/me', {
      headers: { authorization: `Bearer ${invitedToken}` },
    });
    expect(invitedMe.status).toBe(200);
    expect(await invitedMe.json()).toMatchObject({
      state: 'active',
      tenant: { id: tenantId, role: 'member' },
    });
    expect(
      await admin.db
        .select({ status: tenantInvitations.status })
        .from(tenantInvitations)
        .where(eq(tenantInvitations.id, invitation.id)),
    ).toEqual([{ status: 'revoked' }]);

    const removed = await api.request(`/tenant/members/${identities.member.id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removed.status).toBe(200);
    expect(publish).toHaveBeenCalledWith({ userId: identities.member.id, tenantId });
    const removedAccess = await api.request('/tenant/members', {
      headers: { authorization: `Bearer ${memberToken}` },
    });
    expect(removedAccess.status).toBe(403);
    expect(await removedAccess.json()).toEqual({
      error: 'tenant access unavailable',
      state: 'removed',
    });

    expect(
      (
        await api.request(`/tenant/members/${identities.ownerB.id}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await api.request(`/tenant/members/${identities.ownerA.id}/role`, {
          method: 'PUT',
          headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'admin' }),
        })
      ).status,
    ).toBe(409);

    expect(
      (
        await api.request(`/tenant/members/${identities.transferTarget.id}/transfer-ownership`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ownerToken}` },
        })
      ).status,
    ).toBe(200);
    expect(notify).toHaveBeenCalledWith(
      { userId: identities.ownerA.id },
      'workspace.ownership_transferred',
      { workspaceName: 'Members API' },
      { tenantId },
    );
    expect(notify).toHaveBeenCalledWith(
      { userId: identities.transferTarget.id },
      'workspace.ownership_transferred',
      { workspaceName: 'Members API' },
      { tenantId },
    );
  });
});
