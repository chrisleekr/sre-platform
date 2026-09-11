import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  makeDb,
  tenants,
  users,
  memberships,
  identityProviders,
  identityProviderDomains,
  tenantIdentityBindings,
  deleteWorkspaceDomain,
  findDeletingWorkspaceOwner,
  listDeletingWorkspaces,
  type DbHandle,
} from '../index';

let db: DbHandle;
beforeAll(() => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  db = makeDb(process.env.DATABASE_URL!);
});
afterAll(async () => {
  await db?.close();
});

async function fixture(scope: 'installation' | 'tenant') {
  const tenantId = randomUUID();
  const providerId = randomUUID();
  const userId = randomUUID();
  const slug = `safety-${tenantId}`;
  const issuer = `https://${providerId}.invalid`;
  await db.db.insert(tenants).values({ id: tenantId, name: 'Safety checks', slug });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Directory',
    issuer,
    jwksUri: `${issuer}/jwks`,
    audience: 'api',
    kind: 'oidc',
    scope,
    status: 'pending_verification',
  });
  await db.db
    .insert(tenantIdentityBindings)
    .values({ tenantId, providerId, claimValue: scope === 'installation' ? 'org-a' : null });
  await db.db.insert(users).values({ id: userId, issuer, subject: 'owner' });
  await db.db.insert(memberships).values({ tenantId, userId, role: 'owner' });
  return {
    tenantId,
    providerId,
    userId,
    slug,
    async close() {
      await db.db.delete(tenants).where(eq(tenants.id, tenantId));
      await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
      await db.db.delete(users).where(eq(users.id, userId));
    },
  };
}

test('deletion recovery preserves directory policy and the verified organisation claim', async () => {
  const f = await fixture('installation');
  try {
    await db.db
      .update(identityProviders)
      .set({ status: 'active' })
      .where(eq(identityProviders.id, f.providerId));
    await db.db
      .update(tenants)
      .set({ status: 'deleting', deleteAfter: new Date(Date.now() + 60_000) })
      .where(eq(tenants.id, f.tenantId));
    const actor = {
      userId: f.userId,
      providerId: f.providerId,
      slug: f.slug,
      bindingClaimValue: 'org-a',
    };
    expect(await findDeletingWorkspaceOwner(db.db, actor)).toBe(f.tenantId);
    expect(await listDeletingWorkspaces(db.db, actor)).toHaveLength(1);
    const wrongOrganisation = { ...actor, bindingClaimValue: 'org-b' };
    expect(await findDeletingWorkspaceOwner(db.db, wrongOrganisation)).toBeNull();
    expect(await listDeletingWorkspaces(db.db, wrongOrganisation)).toEqual([]);
    expect(
      await findDeletingWorkspaceOwner(db.db, { ...actor, bindingClaimValue: undefined }),
    ).toBeNull();
    await db.db.update(tenants).set({ requireDirectory: true }).where(eq(tenants.id, f.tenantId));
    expect(await findDeletingWorkspaceOwner(db.db, actor)).toBeNull();
    expect(await listDeletingWorkspaces(db.db, actor)).toEqual([]);
    await db.db.update(tenants).set({ requireDirectory: false }).where(eq(tenants.id, f.tenantId));
    await db.db
      .update(identityProviders)
      .set({ status: 'disabled' })
      .where(eq(identityProviders.id, f.providerId));
    expect(await findDeletingWorkspaceOwner(db.db, actor)).toBeNull();
  } finally {
    await f.close();
  }
});

test('domain removal observes a verification that commits while deletion waits for its row lock', async () => {
  const f = await fixture('tenant');
  const domainId = randomUUID();
  let release!: () => void;
  let locked!: (pid: number) => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const updated = new Promise<number>((resolve) => {
    locked = resolve;
  });
  await db.db.insert(identityProviderDomains).values({
    id: domainId,
    providerId: f.providerId,
    domain: `${domainId}.example.test`,
    status: 'pending',
  });
  const verification = db.sql.begin(async (tx) => {
    const [backend] = await tx`select pg_backend_pid() as pid`;
    await tx`update identity_provider_domains set status = 'verified' where id = ${domainId}`;
    await tx`update identity_providers set status = 'active' where id = ${f.providerId}`;
    locked(backend!.pid);
    await hold;
  });
  const verifierPid = await updated;
  const removal = deleteWorkspaceDomain(db.db, f.tenantId, domainId).then(
    () => null,
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(
      async () => {
        const blocked =
          await db.sql`select pid from pg_stat_activity where ${verifierPid} = any(pg_blocking_pids(pid))`;
        expect(blocked.length).toBeGreaterThan(0);
      },
      { timeout: 5_000 },
    );
    release();
    await verification;
    expect(await removal).toMatchObject({ code: 'last_verified_domain' });
    expect(
      await db.db
        .select()
        .from(identityProviderDomains)
        .where(eq(identityProviderDomains.id, domainId)),
    ).toMatchObject([{ status: 'verified' }]);
  } finally {
    release();
    await verification;
    await removal;
    await f.close();
  }
});
