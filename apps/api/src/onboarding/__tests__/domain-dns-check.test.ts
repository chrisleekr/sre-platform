import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  adminActions,
  createAdminImpersonation,
  identityProviderDomains,
  identityProviders,
  impersonationSessions,
  memberships,
  platformOperators,
  tenantIdentityBindings,
  verifyDomainProof,
  withTenant,
} from '@sre/db';
import { createFixture } from '../../__tests__/connectors.fixture';
import { makeTestAuth } from '../../__tests__/auth-test-support';
import { tenantSettingsRoutes } from '../tenant-settings';

const fixture = createFixture();

test('checks DNS for owners and active support admins without widening other settings permissions', async () => {
  const providerId = randomUUID();
  const domainId = randomUUID();
  const [membership] = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.select().from(memberships),
  );
  const actor = membership!.userId;
  const auth = await makeTestAuth({
    adminDb: fixture.admin.db,
    appDb: fixture.app.db,
    issuer: 'https://test.auth0.local/',
    audience: 'sre-api',
    keys: fixture.authKeys,
    bindings: [{ tenantId: fixture.tenantA, subject: fixture.orgA }],
  });
  const resolveTxt = vi.fn(async () => [] as string[][]);
  const checkDomain = vi.fn((id: string) => verifyDomainProof(fixture.admin.db, id, resolveTxt));
  const api = tenantSettingsRoutes({ auth, db: fixture.admin.db, checkDomain });
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  const role = (value: 'owner' | 'admin' | 'member') =>
    withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.update(memberships).set({ role: value }).where(eq(memberships.userId, actor)),
    );
  const check = (extra: Record<string, string> = {}, id = domainId) =>
    api.request(`/tenant/domains/${id}/check`, {
      method: 'POST',
      headers: { ...headers, ...extra },
    });
  try {
    await fixture.admin.db.insert(identityProviders).values({
      id: providerId,
      displayName: 'DNS check directory',
      issuer: `https://${providerId}.invalid`,
      jwksUri: `https://${providerId}.invalid/jwks`,
      kind: 'oidc',
      scope: 'tenant',
      status: 'pending_verification',
      browserClientId: 'test-client',
    });
    await fixture.admin.db
      .insert(tenantIdentityBindings)
      .values({ tenantId: fixture.tenantA, providerId });
    await fixture.admin.db.insert(identityProviderDomains).values({
      id: domainId,
      providerId,
      domain: `${domainId}.example.test`,
      status: 'pending',
      challenge: 'dns-proof',
      expiresAt: new Date(Date.now() + 60_000),
    });
    for (const value of ['member', 'admin'] as const) {
      await role(value);
      expect((await check()).status).toBe(403);
    }
    expect(checkDomain).not.toHaveBeenCalled();
    await role('owner');
    expect(await (await check()).json()).toEqual({ status: 'pending' });
    const [pending] = await fixture.admin.db
      .select()
      .from(identityProviderDomains)
      .where(eq(identityProviderDomains.id, domainId));
    expect(pending!.lastCheckedAt).toBeInstanceOf(Date);

    await role('admin');
    await fixture.admin.db.insert(platformOperators).values({ userId: actor });
    expect((await check()).status).toBe(403);
    const session = await createAdminImpersonation(fixture.admin.db, {
      actorUserId: actor,
      tenantId: fixture.tenantA,
      reason: 'Verify a newly configured DNS proof',
    });
    const support = { 'x-impersonation-session': session.id };
    expect((await check(support, randomUUID())).status).toBe(404);
    const before = resolveTxt.mock.calls.length;
    await withTenant(fixture.app.db, fixture.tenantB, (tx) =>
      tx.update(memberships).set({ role: 'owner' }),
    );
    const other = await api.request(`/tenant/domains/${domainId}/check`, {
      method: 'POST',
      headers: fixture.bearer(await fixture.sign(fixture.orgB)),
    });
    expect(other.status).toBe(404);
    expect(resolveTxt.mock.calls).toHaveLength(before);
    expect(
      (
        await api.request(`/tenant/domains/${domainId}`, {
          method: 'DELETE',
          headers: { ...headers, ...support },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await api.request('/tenant/providers', {
          method: 'POST',
          headers: { ...headers, ...support },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    resolveTxt.mockResolvedValue([['dns-', 'proof']]);
    expect(await (await check(support)).json()).toEqual({ status: 'verified' });
    const [verified] = await fixture.admin.db
      .select()
      .from(identityProviderDomains)
      .where(eq(identityProviderDomains.id, domainId));
    expect(verified!.status).toBe('verified');
    expect(resolveTxt).toHaveBeenLastCalledWith(`_sre-platform.${domainId}.example.test`);
    await fixture.admin.db
      .update(impersonationSessions)
      .set({
        startedAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(impersonationSessions.id, session.id));
    const calls = checkDomain.mock.calls.length;
    expect((await check(support)).status).toBe(403);
    expect(checkDomain.mock.calls).toHaveLength(calls);
  } finally {
    await fixture.admin.db
      .delete(impersonationSessions)
      .where(eq(impersonationSessions.actorUserId, actor));
    await fixture.admin.db.delete(adminActions).where(eq(adminActions.actorUserId, actor));
    await fixture.admin.db.delete(platformOperators).where(eq(platformOperators.userId, actor));
    await fixture.admin.db
      .delete(tenantIdentityBindings)
      .where(eq(tenantIdentityBindings.providerId, providerId));
    await fixture.admin.db
      .delete(identityProviderDomains)
      .where(eq(identityProviderDomains.providerId, providerId));
    await fixture.admin.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  }
});
