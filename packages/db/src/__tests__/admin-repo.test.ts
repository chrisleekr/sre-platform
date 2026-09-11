import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  adminActions,
  createAdminImpersonation,
  endAdminImpersonation,
  getActiveAdminImpersonation,
  grantAdminRole,
  identityProviders,
  impersonationSessions,
  listAdminActions,
  makeDb,
  memberships,
  platformOperators,
  revokeAdminRole,
  setAdminTenantStatus,
  setAdminUserStatus,
  signOutAdminUser,
  tenants,
  users,
  type DbHandle,
} from '..';

const marker = randomUUID();
const actorId = randomUUID();
const targetId = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
let admin: DbHandle;
let appDb: DbHandle;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Admin test staff',
    issuer: `https://staff-${marker}.invalid`,
    jwksUri: `https://staff-${marker}.invalid/jwks`,
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'installation',
    status: 'active',
  });
  await admin.db.insert(tenants).values({ id: tenantId, name: `Admin ${marker}` });
  await admin.db.insert(users).values([
    { id: actorId, issuer: `https://staff-${marker}.invalid`, subject: 'actor' },
    { id: targetId, issuer: `https://staff-${marker}.invalid`, subject: 'target' },
  ]);
  await admin.db.insert(memberships).values({ tenantId, userId: targetId, role: 'owner' });
  await admin.db.insert(platformOperators).values({ userId: actorId });
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  await admin.db.delete(adminActions).where(inArray(adminActions.actorUserId, [actorId, targetId]));
  await admin.db.delete(impersonationSessions).where(eq(impersonationSessions.tenantId, tenantId));
  await admin.db
    .delete(platformOperators)
    .where(inArray(platformOperators.userId, [actorId, targetId]));
  await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await admin.db.delete(users).where(inArray(users.id, [actorId, targetId]));
  await admin.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), appDb.close()]);
});

describe('platform administration repository', () => {
  test('audits tenant and user gates in the same successful mutation', async () => {
    await setAdminTenantStatus(admin.db, {
      actorUserId: actorId,
      tenantId,
      status: 'suspended',
      reason: 'Security review',
    });
    await setAdminUserStatus(admin.db, {
      actorUserId: actorId,
      userId: targetId,
      status: 'disabled',
      reason: 'Compromised session',
    });
    const cutoff = await signOutAdminUser(admin.db, { actorUserId: actorId, userId: targetId });

    expect(cutoff).toBeInstanceOf(Date);
    expect(
      await admin.db
        .select({ action: adminActions.action })
        .from(adminActions)
        .where(eq(adminActions.actorUserId, actorId)),
    ).toEqual(
      expect.arrayContaining([
        { action: 'workspace.suspend' },
        { action: 'user.disable' },
        { action: 'user.sign_out_everywhere' },
      ]),
    );
    await setAdminTenantStatus(admin.db, {
      actorUserId: actorId,
      tenantId,
      status: 'active',
    });
    await setAdminUserStatus(admin.db, {
      actorUserId: actorId,
      userId: targetId,
      status: 'active',
    });
  });

  test('creates, resolves, and ends a bounded impersonation session', async () => {
    const session = await createAdminImpersonation(admin.db, {
      actorUserId: actorId,
      tenantId,
      reason: 'Diagnose the customer-facing authentication failure',
    });
    expect(session.expiresAt.getTime() - session.startedAt.getTime()).toBe(3_600_000);
    expect(await getActiveAdminImpersonation(admin.db, session.id, actorId)).toMatchObject({
      tenantId,
      actorUserId: actorId,
    });
    await endAdminImpersonation(admin.db, { actorUserId: actorId, sessionId: session.id });
    expect(await getActiveAdminImpersonation(admin.db, session.id, actorId)).toBeNull();
  });

  test('pages the administrator trail with a stable keyset cursor', async () => {
    const first = await listAdminActions(admin.db, {
      limit: 1,
      targetKind: 'tenant',
      targetId: tenantId,
    });
    expect(first.actions).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listAdminActions(admin.db, {
      limit: 1,
      targetKind: 'tenant',
      targetId: tenantId,
      after: first.nextCursor!,
    });
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0]!.id).not.toBe(first.actions[0]!.id);
  });

  test('protects the final platform administrator', async () => {
    await grantAdminRole(admin.db, { actorUserId: actorId, userId: targetId });
    await revokeAdminRole(admin.db, { actorUserId: actorId, userId: targetId });
    await expect(
      revokeAdminRole(admin.db, { actorUserId: actorId, userId: actorId }),
    ).rejects.toMatchObject({ code: 'last_admin' });
  });

  test('keeps allowlist writes and audit mutation off the application connection', async () => {
    await expect(
      grantAdminRole(appDb.db, { actorUserId: actorId, userId: targetId }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(
      appDb.db
        .update(adminActions)
        .set({ reason: 'tampered' })
        .where(eq(adminActions.actorUserId, actorId)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await expect(
      appDb.db.insert(impersonationSessions).values({
        actorUserId: actorId,
        tenantId,
        reason: 'bypass the audited support-session route',
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});
