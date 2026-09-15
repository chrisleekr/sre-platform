import { and, eq, sql } from 'drizzle-orm';
import { beforeEach, expect, test } from 'vitest';
import {
  adminActions,
  attachMembership,
  createAdminImpersonation,
  identityProviders,
  memberships,
  platformOperators,
  recoverWorkspaceOwner,
  removeAdminMembership,
  removeTenantMember,
  resolveTenantByBinding,
  setAdminUserStatus,
  tenants,
  tombstoneAdminUser,
  updateAdminProvider,
  users,
  type Db,
} from '@sre/db';
import { ownershipFixture } from './ownership.fixture';

const f = ownershipFixture();
beforeEach(async () => f.reset());
const recover = (userId = f.memberId) =>
  f.request(`/admin/tenants/${f.tenantId}/recover-owner`, {
    userId,
    reason: 'Verified legacy owner recovery',
  });
const direct = (userId = f.memberId) =>
  recoverWorkspaceOwner(f.db.db, {
    actorUserId: f.actorId,
    actorProviderId: f.providerId,
    tenantId: f.tenantId,
    userId,
    reason: 'Verified legacy owner recovery',
  });

test('a stalled admission does not serialize other accounts in the workspace', async () => {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = f.db.db.transaction(async (tx) => {
    await tx.select().from(users).where(eq(users.id, f.memberId)).for('no key update');
    locked();
    await hold;
  });
  await ready;
  const stalled = resolveTenantByBinding(f.appDb.db, {
    providerId: f.providerId,
    claimValue: 'member',
    userId: f.memberId,
  });
  let concurrent: ReturnType<typeof resolveTenantByBinding> | undefined;
  let attached: ReturnType<typeof attachMembership> | undefined;
  try {
    await expect
      .poll(async () => {
        const rows = await f.db.db.execute(
          sql`select exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%"users"%' and query like '%for no key update%') as waiting`,
        );
        return rows[0]?.waiting;
      })
      .toBe(true);
    let admitted = false;
    concurrent = resolveTenantByBinding(f.appDb.db, {
      providerId: f.providerId,
      claimValue: 'member',
      userId: f.peerId,
    }).then((result) => {
      admitted = result.status === 'ok';
      return result;
    });
    await expect.poll(() => admitted).toBe(true);
    const [peer] = await f.db.db.select().from(users).where(eq(users.id, f.peerId));
    let attachedDone = false;
    attached = attachMembership(
      f.db.db,
      { issuer: peer!.issuer, subject: peer!.subject },
      f.tenantId,
    ).then((result) => {
      attachedDone = true;
      return result;
    });
    await expect.poll(() => attachedDone).toBe(true);
  } finally {
    release();
    await Promise.all([blocker, stalled, concurrent, attached]);
  }
});

test('provider updates can append their actor audit while recovery waits on the provider', async () => {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const update = f.db.db.transaction(async (tx) => {
    await tx
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.id, f.providerId))
      .for('update');
    locked();
    await hold;
    return updateAdminProvider(tx as unknown as Db, {
      actorUserId: f.actorId,
      providerId: f.providerId,
      patch: { status: 'disabled' },
      reason: 'Disable compromised provider',
    });
  });
  await ready;
  const recovery = Promise.allSettled([direct()]);
  const updated = Promise.allSettled([update]);
  try {
    await expect
      .poll(async () => {
        const rows = await f.db.db.execute(
          sql`select exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%"identity_providers"%' and query like '%for share%') as waiting`,
        );
        return rows[0]?.waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  expect(await updated).toEqual([expect.objectContaining({ status: 'fulfilled' })]);
  expect(await recovery).toEqual([
    expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'forbidden' }),
    }),
  ]);
  expect(await f.role()).toBe('member');
});

test('waiting recovery observes administrator revocation before granting ownership', async () => {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoke = f.db.db.transaction(async (tx) => {
    await tx.execute(sql`lock table platform_operators in share row exclusive mode`);
    await tx.delete(platformOperators).where(eq(platformOperators.userId, f.actorId));
    locked();
    await hold;
  });
  await ready;
  const attempt = direct();
  // Attach the rejection handler before releasing the blocked transaction.
  const result = Promise.allSettled([attempt]);
  try {
    await expect
      .poll(async () => {
        const rows = await f.db.db.execute(
          sql`select exists (select 1 from pg_locks where relation = 'platform_operators'::regclass and mode = 'ShareLock' and not granted) as waiting`,
        );
        return rows[0]?.waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  await revoke;
  expect(await result).toEqual([
    expect.objectContaining({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'forbidden' }),
    }),
  ]);
  expect(await f.role()).toBe('member');
});

test('admission waiting on a workspace lock rechecks suspension after acquiring it', async () => {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const suspend = f.db.db.transaction(async (tx) => {
    await tx.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, f.tenantId));
    locked();
    await hold;
  });
  await ready;
  const attempt = resolveTenantByBinding(f.appDb.db, {
    providerId: f.providerId,
    claimValue: 'member',
    userId: f.memberId,
  });
  try {
    await expect
      .poll(async () => {
        const rows = await f.db.db.execute(
          sql`select exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%"tenants"%' and query like '%for share%') as waiting`,
        );
        return rows[0]?.waiting;
      })
      .toBe(true);
  } finally {
    release();
  }
  await suspend;
  expect(await attempt).toEqual({ status: 'suspended', tenantId: f.tenantId });
});

test('account-wide changes refuse stale workspace scope discovery instead of skipping new memberships', async () => {
  let release!: () => void;
  let locked!: () => void;
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const blocker = f.db.db.transaction(async (tx) => {
    await tx.select().from(tenants).where(eq(tenants.id, f.tenantId)).for('update');
    locked();
    await hold;
  });
  await ready;
  const outcomes = Promise.allSettled([
    setAdminUserStatus(f.db.db, { actorUserId: f.actorId, userId: f.memberId, status: 'disabled' }),
  ]);
  try {
    await expect
      .poll(async () => {
        const rows = await f.db.db.execute(
          sql`select exists (select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like '%"tenants"%' and query like '%for update%') as waiting`,
        );
        return rows[0]?.waiting;
      })
      .toBe(true);
    const [user] = await f.db.db.select().from(users).where(eq(users.id, f.memberId));
    await attachMembership(
      f.db.db,
      { issuer: user!.issuer, subject: user!.subject },
      f.otherTenantId,
    );
  } finally {
    release();
  }
  await blocker;
  try {
    expect(await outcomes).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'conflict' }),
      }),
    ]);
    const [user] = await f.db.db.select().from(users).where(eq(users.id, f.memberId));
    expect(user!.status).toBe('active');
  } finally {
    await f.db.db
      .delete(memberships)
      .where(and(eq(memberships.tenantId, f.otherTenantId), eq(memberships.userId, f.memberId)));
  }
});

test('reports ownerless state to ordinary members and refreshes stored authorization after audited recovery', async () => {
  const before = await f.request('/tenant/members', undefined, f.memberToken);
  expect(await before.json()).toMatchObject({
    ownership: { state: 'missing_owner', activeOwnerCount: 0 },
    members: [{ status: 'active' }, { status: 'active' }],
  });
  expect((await recover()).status).toBe(200);
  expect(await f.role()).toBe('owner');
  const after = await f.request('/tenant/members', undefined, f.memberToken);
  expect(await after.json()).toMatchObject({
    ownership: { state: 'owned', activeOwnerCount: 1 },
    invitations: [],
  });
  expect(
    await f.db.db.select().from(adminActions).where(eq(adminActions.actorUserId, f.actorId)),
  ).toEqual([
    expect.objectContaining({
      action: 'workspace.owner_recover',
      targetId: f.tenantId,
      details: { userId: f.memberId, previousRole: 'member', role: 'owner', inactiveOwnerCount: 0 },
    }),
  ]);
  expect((await recover(f.peerId)).status).toBe(409);
});

test('requires real administrator authority even during a support session', async () => {
  const body = { userId: f.memberId, reason: 'Recover ownership' };
  expect(
    (await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, body, f.memberToken)).status,
  ).toBe(403);
  const support = await createAdminImpersonation(f.db.db, {
    actorUserId: f.actorId,
    tenantId: f.tenantId,
    reason: 'Investigate ownerless workspace',
  });
  expect(
    (
      await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, body, f.actorToken, {
        'x-impersonation-session': support.id,
      })
    ).status,
  ).toBe(200);
  expect(await f.role()).toBe('owner');
  const [audit] = await f.db.db
    .select()
    .from(adminActions)
    .where(eq(adminActions.action, 'workspace.owner_recover'));
  expect(audit).toMatchObject({ actorUserId: f.actorId, targetId: f.tenantId });
  await f.db.db.delete(platformOperators).where(eq(platformOperators.userId, f.actorId));
  expect(
    (
      await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, body, f.actorToken, {
        'x-impersonation-session': support.id,
      })
    ).status,
  ).toBe(403);
});

test('supports the existing armed local administrator gate but never accepts it from request JSON', async () => {
  await f.db.db
    .update(identityProviders)
    .set({ scope: 'tenant', kind: 'local' })
    .where(eq(identityProviders.id, f.providerId));
  expect((await recover()).status).toBe(403);
  const spoof = { userId: f.memberId, reason: 'Recover workspace', allowLocal: true };
  expect((await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, spoof)).status).toBe(403);
  f.allowLocal(true);
  expect((await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, spoof)).status).toBe(400);
  expect((await recover()).status).toBe(200);
});

test('the local gate never authorizes a workspace-scoped OIDC identity', async () => {
  f.allowLocal(true);
  await f.db.db
    .update(identityProviders)
    .set({ scope: 'tenant' })
    .where(eq(identityProviders.id, f.providerId));
  expect((await recover()).status).toBe(403);
});

test('enabling an existing owner races safely with recovery without removing any grants', async () => {
  await f.db.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.userId, f.peerId));
  await f.db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.peerId));
  const outcomes = await Promise.allSettled([
    direct(),
    setAdminUserStatus(f.db.db, { actorUserId: f.actorId, userId: f.peerId, status: 'active' }),
  ]);
  expect(outcomes[1]?.status).toBe('fulfilled');
  expect(await f.role(f.peerId)).toBe('owner');
  expect(await f.role()).toBe(outcomes[0]?.status === 'fulfilled' ? 'owner' : 'member');
});

test('requires an exact active member, active workspace and nonempty reason', async () => {
  expect((await recover(f.actorId)).status).toBe(422);
  expect(
    (
      await f.request(`/admin/tenants/${f.otherTenantId}/recover-owner`, {
        userId: f.memberId,
        reason: 'Wrong workspace target',
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await f.request(`/admin/tenants/${f.tenantId}/recover-owner`, {
        userId: f.memberId,
        reason: ' ',
      })
    ).status,
  ).toBe(400);
  await f.db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.memberId));
  expect((await recover()).status).toBe(422);
  await f.db.db.update(users).set({ status: 'active' }).where(eq(users.id, f.memberId));
  await f.db.db
    .update(memberships)
    .set({ status: 'removed' })
    .where(eq(memberships.userId, f.memberId));
  expect((await recover()).status).toBe(422);
  await f.db.db.update(tenants).set({ status: 'suspended' }).where(eq(tenants.id, f.tenantId));
  expect((await recover()).status).toBe(409);
});

test('keeps security disabling possible and discloses preserved inactive owner grants', async () => {
  await f.db.db.update(memberships).set({ role: 'owner' }).where(eq(memberships.userId, f.peerId));
  await setAdminUserStatus(f.db.db, {
    actorUserId: f.actorId,
    userId: f.peerId,
    status: 'disabled',
    reason: 'Compromised account',
  });
  const projection = await f.request('/tenant/members', undefined, f.memberToken);
  expect(await projection.json()).toMatchObject({
    ownership: { state: 'inactive_owners', activeOwnerCount: 0, inactiveOwnerCount: 1 },
  });
  expect((await recover()).status).toBe(200);
  expect(await f.role(f.peerId)).toBe('owner');
  const [peer] = await f.db.db.select().from(users).where(eq(users.id, f.peerId));
  expect(peer!.status).toBe('disabled');
});

test.each(['revoked', 'disabled', 'wrong provider', 'inactive provider', 'tenant provider'])(
  'rechecks live administrator authority inside recovery: %s',
  async (condition) => {
    if (condition === 'revoked')
      await f.db.db.delete(platformOperators).where(eq(platformOperators.userId, f.actorId));
    if (condition === 'disabled')
      await f.db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.actorId));
    if (condition === 'inactive provider')
      await f.db.db
        .update(identityProviders)
        .set({ status: 'disabled' })
        .where(eq(identityProviders.id, f.providerId));
    if (condition === 'tenant provider')
      await f.db.db
        .update(identityProviders)
        .set({ scope: 'tenant' })
        .where(eq(identityProviders.id, f.providerId));
    await expect(
      recoverWorkspaceOwner(f.db.db, {
        actorUserId: f.actorId,
        actorProviderId: condition === 'wrong provider' ? f.otherTenantId : f.providerId,
        tenantId: f.tenantId,
        userId: f.memberId,
        reason: 'Recover ownership',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(await f.role()).toBe('member');
  },
);

test('rolls back the recovered role if appending the audit fails', async () => {
  await f.db.db.execute(
    sql`create function public.ownership_test_reject_audit() returns trigger language plpgsql as $$ begin raise exception 'test audit unavailable'; end $$`,
  );
  await f.db.db.execute(
    sql`create trigger ownership_test_reject before insert on admin_actions for each row execute function public.ownership_test_reject_audit()`,
  );
  try {
    await expect(direct()).rejects.toThrow();
    expect(await f.role()).toBe('member');
  } finally {
    await f.db.db.execute(sql`drop trigger ownership_test_reject on admin_actions`);
    await f.db.db.execute(sql`drop function public.ownership_test_reject_audit()`);
  }
});

test('serializes two recovery attempts so exactly one succeeds', async () => {
  const outcomes = await Promise.allSettled([direct(), direct(f.peerId)]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  expect([await f.role(), await f.role(f.peerId)].filter((role) => role === 'owner')).toHaveLength(
    1,
  );
});

test('serializes administrator removal against normal owner removal', async () => {
  await f.db.db
    .update(memberships)
    .set({ role: 'owner' })
    .where(eq(memberships.tenantId, f.tenantId));
  const outcomes = await Promise.allSettled([
    removeAdminMembership(f.db.db, {
      actorUserId: f.actorId,
      tenantId: f.tenantId,
      userId: f.memberId,
    }),
    removeTenantMember(f.appDb.db, {
      actorUserId: f.peerId,
      tenantId: f.tenantId,
      targetUserId: f.peerId,
    }),
  ]);
  expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
  const remaining = await f.db.db
    .select()
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, f.tenantId),
        eq(memberships.status, 'active'),
        eq(memberships.role, 'owner'),
      ),
    );
  expect(remaining).toHaveLength(1);
});

test('deletion racing with admission never leaves a deleted account with an active membership', async () => {
  await Promise.allSettled([
    tombstoneAdminUser(f.db.db, { actorUserId: f.actorId, userId: f.memberId }),
    resolveTenantByBinding(f.appDb.db, {
      providerId: f.providerId,
      claimValue: 'member',
      userId: f.memberId,
    }),
  ]);
  const [user] = await f.db.db.select().from(users).where(eq(users.id, f.memberId));
  expect(user!.status).toBe('deleted');
  expect(
    await f.db.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, f.memberId), eq(memberships.status, 'active'))),
  ).toHaveLength(0);
  // Restore identity only for this isolated fixture's later signed requests.
  await f.db.db
    .update(users)
    .set({ subject: 'member', email: 'member@example.test' })
    .where(eq(users.id, f.memberId));
});
