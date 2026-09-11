import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createTenantInvitation,
  identityProviderDomains,
  identityProviders,
  listTenantMembers,
  makeDb,
  memberships,
  removeTenantMember,
  setTenantMemberRole,
  tenantInvitations,
  tenantIdentityBindings,
  tenants,
  transferTenantOwnership,
  users,
  type DbHandle,
} from '../index';

const marker = randomUUID();
const tenantId = randomUUID();
const ownerA = randomUUID();
const ownerB = randomUUID();
const adminId = randomUUID();
const memberId = randomUUID();
const providerId = randomUUID();
const lastSignInAt = new Date('2026-09-04T10:00:00.000Z');
let db: DbHandle;

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db
    .insert(tenants)
    .values({ id: tenantId, name: `Members ${marker}`, slug: `members-${marker}` });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: `Members directory ${marker}`,
    issuer: `https://members-${marker}.invalid`,
    jwksUri: `https://members-${marker}.invalid/jwks`,
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'tenant',
    status: 'pending_verification',
  });
  await db.db
    .insert(identityProviderDomains)
    .values({ providerId, domain: 'example.test', status: 'pending' });
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await db.db.insert(users).values([
    {
      id: ownerA,
      issuer: `https://members-${marker}.invalid`,
      subject: 'owner-a',
      email: `owner-a-${marker}@example.test`,
      lastSignInAt,
    },
    {
      id: ownerB,
      issuer: `https://members-${marker}.invalid`,
      subject: 'owner-b',
      email: `owner-b-${marker}@example.test`,
    },
    {
      id: adminId,
      issuer: `https://members-${marker}.invalid`,
      subject: 'admin',
      email: `admin-${marker}@example.test`,
    },
    {
      id: memberId,
      issuer: `https://members-${marker}.invalid`,
      subject: 'member',
      email: `member-${marker}@example.test`,
    },
  ]);
  await db.db.insert(memberships).values([
    { tenantId, userId: ownerA, role: 'owner' },
    { tenantId, userId: ownerB, role: 'owner' },
    { tenantId, userId: adminId, role: 'admin' },
    { tenantId, userId: memberId, role: 'member' },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(tenantInvitations).where(eq(tenantInvitations.tenantId, tenantId));
  await db.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await db.db.delete(tenantIdentityBindings).where(eq(tenantIdentityBindings.tenantId, tenantId));
  await db.db
    .delete(identityProviderDomains)
    .where(eq(identityProviderDomains.providerId, providerId));
  await db.db.delete(users).where(inArray(users.id, [ownerA, ownerB, adminId, memberId]));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

describe('tenant membership repository', () => {
  test('lists active and removed members with useful sign-in metadata', async () => {
    const rows = await listTenantMembers(db.db, tenantId);
    expect(rows.map((row) => row.userId)).toEqual(
      expect.arrayContaining([ownerA, ownerB, adminId, memberId]),
    );
    expect(rows.find((row) => row.userId === ownerA)).toMatchObject({
      email: `owner-a-${marker}@example.test`,
      lastSignInAt,
      role: 'owner',
      status: 'active',
      provider: {
        displayName: `Members directory ${marker}`,
        scope: 'tenant',
        status: 'pending_verification',
        directoryStatus: 'pending',
      },
    });
  });

  test('protects the last owner while permitting removal when another owner exists', async () => {
    expect(
      await removeTenantMember(db.db, { tenantId, actorUserId: ownerA, targetUserId: ownerB }),
    ).toMatchObject({ removed: true });
    await expect(
      setTenantMemberRole(db.db, {
        tenantId,
        actorUserId: ownerA,
        targetUserId: ownerA,
        role: 'admin',
      }),
    ).rejects.toMatchObject({ code: 'last_owner' });
  });

  test('prevents an admin from removing privileged members but permits ordinary members', async () => {
    await expect(
      removeTenantMember(db.db, { tenantId, actorUserId: adminId, targetUserId: ownerA }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      await removeTenantMember(db.db, { tenantId, actorUserId: adminId, targetUserId: memberId }),
    ).toMatchObject({ removed: true });
  });

  test('transfers ownership atomically', async () => {
    await db.db
      .update(memberships)
      .set({ status: 'active', role: 'member' })
      .where(eq(memberships.userId, memberId));
    await transferTenantOwnership(db.db, { tenantId, actorUserId: ownerA, targetUserId: memberId });
    const roles = await db.db
      .select({ userId: memberships.userId, role: memberships.role })
      .from(memberships)
      .where(
        sql`${memberships.tenantId} = ${tenantId} and ${memberships.userId} in (${ownerA}, ${memberId})`,
      );
    expect(roles).toEqual(
      expect.arrayContaining([
        { userId: ownerA, role: 'admin' },
        { userId: memberId, role: 'owner' },
      ]),
    );
  });

  test('serializes concurrent cross-removals so one active owner always remains', async () => {
    const raceTenantId = randomUUID();
    await db.db.insert(tenants).values({
      id: raceTenantId,
      name: `Owner race ${marker}`,
      slug: `owner-race-${marker}`,
    });
    await db.db.insert(memberships).values([
      { tenantId: raceTenantId, userId: ownerA, role: 'owner' },
      { tenantId: raceTenantId, userId: ownerB, role: 'owner' },
    ]);
    try {
      const results = await Promise.allSettled([
        removeTenantMember(db.db, {
          tenantId: raceTenantId,
          actorUserId: ownerA,
          targetUserId: ownerB,
        }),
        removeTenantMember(db.db, {
          tenantId: raceTenantId,
          actorUserId: ownerB,
          targetUserId: ownerA,
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(
        await db.db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(
            sql`${memberships.tenantId} = ${raceTenantId} and ${memberships.role} = 'owner' and ${memberships.status} = 'active'`,
          ),
      ).toHaveLength(1);
    } finally {
      await db.db.delete(memberships).where(eq(memberships.tenantId, raceTenantId));
      await db.db.delete(tenants).where(eq(tenants.id, raceTenantId));
    }
  });

  test('enforces one pending invitation per normalized tenant email', async () => {
    const invitation = await createTenantInvitation(db.db, {
      tenantId,
      email: `Invite-${marker}@Example.Test`,
      role: 'member',
      invitedByUserId: memberId,
    });
    expect(invitation.email).toBe(`invite-${marker}@example.test`);
    await expect(
      createTenantInvitation(db.db, {
        tenantId,
        email: `INVITE-${marker}@EXAMPLE.TEST`,
        role: 'admin',
        invitedByUserId: memberId,
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });
});
