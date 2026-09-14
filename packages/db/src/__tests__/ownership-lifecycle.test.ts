import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  adminActions,
  identityProviders,
  makeDb,
  memberships,
  removeAdminMembership,
  removeTenantMember,
  resolveTenantByBinding,
  setTenantMemberRole,
  tenantIdentityBindings,
  tenants,
  tombstoneAdminUser,
  transferTenantOwnership,
  users,
  type DbHandle,
} from '../index';

let db: DbHandle;
let tenantId: string;
let providerId: string;
let actorId: string;
let ownerId: string;
let memberId: string;

beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});

beforeEach(async () => {
  tenantId = randomUUID();
  providerId = randomUUID();
  actorId = randomUUID();
  ownerId = randomUUID();
  memberId = randomUUID();
  const issuer = `https://ownership-${tenantId}.invalid`;
  await db.db.insert(tenants).values({ id: tenantId, name: `Ownership ${tenantId}` });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Ownership test installation',
    issuer,
    jwksUri: `${issuer}/jwks`,
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'installation',
    status: 'active',
  });
  await db.db.insert(users).values(
    [actorId, ownerId, memberId].map((id) => ({
      id,
      issuer,
      subject: id,
      email: `${id}@example.test`,
    })),
  );
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId });
  await db.db.insert(memberships).values([
    { tenantId, userId: ownerId, role: 'owner' },
    { tenantId, userId: memberId, role: 'member' },
  ]);
});

afterEach(async () => {
  await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorId));
  await db.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await db.db.delete(tenantIdentityBindings).where(eq(tenantIdentityBindings.tenantId, tenantId));
  await db.db.delete(users).where(inArray(users.id, [actorId, ownerId, memberId]));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
});

afterAll(async () => {
  await db.close();
});

async function ownerMembership() {
  const [membership] = await db.db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, ownerId)));
  return membership;
}

describe('workspace ownership across account changes', () => {
  test.each(['active', 'disabled'] as const)(
    'refuses deleting a sole %s owner without changing identity or audit',
    async (status) => {
      await db.db.update(users).set({ status }).where(eq(users.id, ownerId));
      await expect(
        tombstoneAdminUser(db.db, { actorUserId: actorId, userId: ownerId }),
      ).rejects.toMatchObject({ code: 'last_owner' });
      expect(await ownerMembership()).toEqual({ role: 'owner', status: 'active' });
      const [owner] = await db.db.select().from(users).where(eq(users.id, ownerId));
      expect(owner).toMatchObject({ status, subject: ownerId });
      expect(
        await db.db.select().from(adminActions).where(eq(adminActions.actorUserId, actorId)),
      ).toHaveLength(0);
    },
  );

  test.each(['disabled', 'deleted'] as const)(
    'refuses transferring ownership to a %s account',
    async (status) => {
      await db.db.update(users).set({ status }).where(eq(users.id, memberId));
      await expect(
        transferTenantOwnership(db.db, {
          tenantId,
          actorUserId: ownerId,
          targetUserId: memberId,
        }),
      ).rejects.toThrow();
      expect(await ownerMembership()).toEqual({ role: 'owner', status: 'active' });
    },
  );

  test.each(['demote', 'workspace removal', 'administrator removal'] as const)(
    'does not count a disabled owner as a surviving owner during %s',
    async (operation) => {
      await db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, memberId));
      await db.db
        .update(memberships)
        .set({ role: 'owner' })
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, memberId)));
      const input = { tenantId, actorUserId: ownerId, targetUserId: ownerId };
      const mutation =
        operation === 'demote'
          ? setTenantMemberRole(db.db, { ...input, role: 'admin' })
          : operation === 'workspace removal'
            ? removeTenantMember(db.db, input)
            : removeAdminMembership(db.db, { tenantId, actorUserId: actorId, userId: ownerId });
      await expect(mutation).rejects.toMatchObject({ code: 'last_owner' });
      expect(await ownerMembership()).toEqual({ role: 'owner', status: 'active' });
    },
  );

  test.each(['disabled', 'deleted'] as const)(
    'does not admit a user whose account became %s after identity verification',
    async (status) => {
      await db.db
        .delete(memberships)
        .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, memberId)));
      await db.db.update(users).set({ status }).where(eq(users.id, memberId));
      const outcome = await Promise.allSettled([
        resolveTenantByBinding(db.db, { providerId, claimValue: null, userId: memberId }),
      ]);
      expect(
        await db.db
          .select()
          .from(memberships)
          .where(and(eq(memberships.tenantId, tenantId), eq(memberships.userId, memberId))),
      ).toHaveLength(0);
      expect(outcome[0]).not.toMatchObject({ status: 'fulfilled', value: { status: 'ok' } });
    },
  );
});
