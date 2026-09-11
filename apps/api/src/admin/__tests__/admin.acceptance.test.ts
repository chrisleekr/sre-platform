import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  adminActions,
  grantAdminRole,
  identityProviders,
  impersonationSessions,
  incidentMessages,
  incidents,
  jobs,
  makeDb,
  makeSecretStore,
  memberships,
  notifications,
  platformOperators,
  platformSettings,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { PlatformSettings } from '@sre/platform-settings';
import { makeFoundingQueue } from '@sre/queue';
import type { Notifier } from '@sre/notifications';
import { makeApp } from '../../app';
import type { AuthDeps } from '../../auth';
import {
  adminAuditCount,
  makeAdminIds,
  makeAuditedAdminMutation,
  makeIdentitySigner,
  makeTestKeys,
  redeemImpersonationTicket,
  type TestKeySet,
} from './admin.acceptance.fixture';
const marker = randomUUID();
const audience = 'sre-api';
const staffIssuer = `https://staff-${marker}.invalid`;
const tenantIssuer = `https://tenant-${marker}.invalid`;
const ids = makeAdminIds();
let admin: DbHandle;
let appDb: DbHandle;
let redis: Redis;
let settings: PlatformSettings;
let api: ReturnType<typeof makeApp>;
let staffKeys: TestKeySet;
let tenantKeys: TestKeySet;
let auth: AuthDeps;
let sign: ReturnType<typeof makeIdentitySigner>;
let adminMutation: ReturnType<typeof makeAuditedAdminMutation>;
const notify = vi.fn<Notifier['notify']>(async () => undefined);
const invalidate = vi.fn();

const auditCount = () => adminAuditCount(admin.db, ids.actor);

async function expectMutationStatus(path: string, init: RequestInit, status = 200): Promise<void> {
  expect((await adminMutation(path, init)).status).toBe(status);
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { maxRetriesPerRequest: 1 });
  const staff = await makeTestKeys('staff');
  const tenant = await makeTestKeys('tenant');
  staffKeys = staff.keys;
  tenantKeys = tenant.keys;
  sign = makeIdentitySigner({
    audience,
    staffIssuer,
    tenantIssuer,
    staffPrivateKey: staff.privateKey,
    tenantPrivateKey: tenant.privateKey,
  });
  await admin.db.insert(identityProviders).values([
    {
      id: ids.staffProvider,
      displayName: 'Staff directory',
      issuer: staffIssuer,
      jwksUri: `${staffIssuer}/jwks`,
      audience,
      browserClientId: 'staff-browser-client',
      kind: 'oidc',
      scope: 'installation',
      tenantClaim: 'organisation',
      status: 'active',
    },
    {
      id: ids.tenantProvider,
      displayName: 'Tenant directory',
      issuer: tenantIssuer,
      jwksUri: `${tenantIssuer}/jwks`,
      audience,
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
  ]);
  await admin.db.insert(tenants).values([
    { id: ids.tenant, name: 'Primary workspace', slug: `primary-${marker}` },
    { id: ids.supportTenant, name: 'Support workspace', slug: `support-${marker}` },
  ]);
  await admin.db.insert(tenantIdentityBindings).values([
    { tenantId: ids.tenant, providerId: ids.staffProvider, claimValue: 'primary' },
    { tenantId: ids.tenant, providerId: ids.tenantProvider, claimValue: null },
  ]);
  await admin.db.insert(users).values([
    {
      id: ids.actor,
      issuer: staffIssuer,
      subject: 'administrator',
      email: 'administrator@example.test',
    },
    { id: ids.target, issuer: staffIssuer, subject: 'target', email: 'target@example.test' },
    { id: ids.rogue, issuer: tenantIssuer, subject: 'rogue', email: 'rogue@example.test' },
  ]);
  await admin.db.insert(memberships).values([
    { tenantId: ids.tenant, userId: ids.actor, role: 'owner' },
    { tenantId: ids.tenant, userId: ids.target, role: 'member' },
    { tenantId: ids.tenant, userId: ids.rogue, role: 'member' },
    { tenantId: ids.supportTenant, userId: ids.actor, role: 'owner' },
  ]);
  await admin.db.insert(platformOperators).values([{ userId: ids.actor }, { userId: ids.rogue }]);
  await admin.db.insert(workspaceFoundings).values([
    {
      id: ids.pendingFounding,
      path: 'own_directory',
      slug: `pending-${marker}`,
      requestedName: 'Pending workspace',
      providerId: ids.staffProvider,
      founderUserId: ids.target,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    {
      id: ids.rejectedFounding,
      path: 'own_directory',
      slug: `reject-${marker}`,
      requestedName: 'Rejected workspace',
      providerId: ids.staffProvider,
      founderUserId: ids.target,
      status: 'pending',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
    {
      id: ids.failedFounding,
      path: 'own_directory',
      slug: `failed-${marker}`,
      requestedName: 'Failed workspace',
      providerId: ids.staffProvider,
      founderUserId: ids.target,
      status: 'failed',
      failureReason: 'Provisioner unavailable',
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  ]);
  settings = new PlatformSettings(admin.db, redis, {
    env: { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
  });
  const verifiers: AuthDeps['verifiers'] = {
    async byIssuer(issuer) {
      const [provider] = await admin.db
        .select()
        .from(identityProviders)
        .where(and(eq(identityProviders.issuer, issuer), eq(identityProviders.status, 'active')))
        .limit(1);
      if (!provider?.audience) return undefined;
      return {
        providerId: provider.id,
        issuer: provider.issuer,
        audience: provider.audience,
        keys: provider.id === ids.staffProvider ? staffKeys : tenantKeys,
        emailClaim: provider.emailClaim,
        subjectClaim: provider.subjectClaim,
        tenantClaim: provider.tenantClaim,
        scope: provider.scope,
      };
    },
    forFounding: async () => undefined,
    invalidate,
  };
  auth = {
    verifiers,
    db: appDb.db,
    adminDb: admin.db,
    settings,
    revoke: { publish: vi.fn(async () => undefined) },
  };
  const queue = makeFoundingQueue(admin.db, redis);
  api = makeApp({
    auth,
    readinessDb: appDb.db,
    appDb: appDb.db,
    adminDb: admin.db,
    secrets: makeSecretStore(appDb.db, Buffer.alloc(32, 7).toString('base64')),
    cache: { get: async () => [], set: async () => undefined },
    settings,
    foundingQueue: queue,
    notifier: { notify },
    registrationMode: () => settings.get('REGISTRATION_MODE'),
    publicRateLimiter: { allow: async () => true },
    publicSourceAddress: () => '127.0.0.1',
  });
  adminMutation = makeAuditedAdminMutation({
    request: async (path, init) => api.request(path, init),
    auditCount,
    getToken: () => sign('administrator'),
  });
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  await admin.db
    .delete(notifications)
    .where(inArray(notifications.recipientUserId, [ids.actor, ids.target, ids.rogue]));
  await admin.db
    .delete(jobs)
    .where(inArray(jobs.idempotencyKey, [ids.pendingFounding, ids.failedFounding]));
  await admin.db
    .delete(incidentMessages)
    .where(inArray(incidentMessages.tenantId, [ids.tenant, ids.supportTenant]));
  await admin.db
    .delete(incidents)
    .where(inArray(incidents.tenantId, [ids.tenant, ids.supportTenant]));
  await admin.db
    .delete(adminActions)
    .where(inArray(adminActions.actorUserId, [ids.actor, ids.rogue]));
  await admin.db
    .delete(impersonationSessions)
    .where(inArray(impersonationSessions.tenantId, [ids.tenant, ids.supportTenant]));
  await admin.db
    .delete(workspaceFoundings)
    .where(
      inArray(workspaceFoundings.id, [
        ids.pendingFounding,
        ids.rejectedFounding,
        ids.failedFounding,
      ]),
    );
  await admin.db
    .delete(platformOperators)
    .where(inArray(platformOperators.userId, [ids.actor, ids.target, ids.rogue]));
  await admin.db
    .delete(memberships)
    .where(inArray(memberships.tenantId, [ids.tenant, ids.supportTenant]));
  await admin.db
    .delete(tenantIdentityBindings)
    .where(inArray(tenantIdentityBindings.tenantId, [ids.tenant, ids.supportTenant]));
  await admin.db.delete(users).where(inArray(users.id, [ids.actor, ids.target, ids.rogue]));
  await admin.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [ids.staffProvider, ids.tenantProvider]));
  await admin.db.delete(tenants).where(inArray(tenants.id, [ids.tenant, ids.supportTenant]));
  await admin.db
    .delete(platformSettings)
    .where(inArray(platformSettings.key, ['REGISTRATION_MODE', 'PRODUCT_NAME']));
  redis.disconnect();
  await Promise.all([admin.close(), appDb.close()]);
});

describe('platform administration API', () => {
  test('requires a listed installation-scoped identity', async () => {
    expect((await api.request('/admin/foundings')).status).toBe(401);
    const rogue = await sign('rogue', { issuer: tenantIssuer });
    expect(
      (await api.request('/admin/foundings', { headers: { authorization: `Bearer ${rogue}` } }))
        .status,
    ).toBe(403);
    const adminToken = await sign('administrator');
    expect(
      (
        await api.request('/admin/foundings', {
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).status,
    ).toBe(200);
  });

  test('approves or rejects registrations with one audit row and a notification', async () => {
    expect(
      (await adminMutation(`/admin/foundings/${ids.pendingFounding}/approve`, { method: 'POST' }))
        .status,
    ).toBe(202);
    expect(
      (
        await adminMutation(`/admin/foundings/${ids.rejectedFounding}/reject`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Directory ownership could not be verified' }),
        })
      ).status,
    ).toBe(200);
    expect(notify).toHaveBeenCalledWith(
      { userId: ids.target },
      'founding.approved',
      { workspaceName: 'Pending workspace' },
      expect.anything(),
    );
    expect(
      (await adminMutation(`/admin/foundings/${ids.failedFounding}/retry`, { method: 'POST' }))
        .status,
    ).toBe(202);
    expect(notify).toHaveBeenCalledWith(
      { userId: ids.target },
      'founding.rejected',
      expect.objectContaining({ reason: 'Directory ownership could not be verified' }),
      expect.anything(),
    );
  });

  test('applies workspace gates and validates a bounded impersonation session', async () => {
    await admin.db
      .update(tenants)
      .set({ requireDirectory: true })
      .where(eq(tenants.id, ids.tenant));
    await expectMutationStatus(`/admin/tenants/${ids.tenant}/clear-require-directory`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Restore emergency platform sign-in access' }),
    });
    expect(notify).toHaveBeenCalledWith(
      { userId: ids.actor },
      'workspace.require_directory_cleared',
      { workspaceName: 'Primary workspace' },
      { tenantId: ids.tenant },
    );
    await expectMutationStatus(`/admin/tenants/${ids.tenant}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Investigating credential exposure' }),
    });
    const target = await sign('target');
    expect(
      await (await api.request('/me', { headers: { authorization: `Bearer ${target}` } })).json(),
    ).toMatchObject({ state: 'suspended' });
    await expectMutationStatus(`/admin/tenants/${ids.tenant}/reactivate`, { method: 'POST' });
    await expectMutationStatus(
      `/admin/tenants/${ids.supportTenant}/bindings`,
      {
        method: 'POST',
        body: JSON.stringify({ providerId: ids.staffProvider, claimValue: 'support' }),
      },
      201,
    );
    const boundIdentity = await api.request('/me', {
      headers: {
        authorization: `Bearer ${await sign('administrator', { organisation: 'support' })}`,
      },
    });
    expect(await boundIdentity.json()).toMatchObject({ tenant: { id: ids.supportTenant } });
    const started = await adminMutation(`/admin/tenants/${ids.supportTenant}/impersonate`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Diagnose a customer-visible authentication failure' }),
    });
    const session = ((await started.json()) as { session: { id: string; expiresAt: string } })
      .session;
    expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(3_500_000);
    expect(notify).toHaveBeenCalledWith(
      { userId: ids.actor },
      'workspace.impersonated',
      expect.objectContaining({ state: 'started' }),
      expect.anything(),
    );
    const adminToken = await sign('administrator');
    const viewed = await api.request('/me', {
      headers: { authorization: `Bearer ${adminToken}`, 'x-impersonation-session': session.id },
    });
    expect(await viewed.json()).toMatchObject({
      tenant: { id: ids.supportTenant, role: 'admin', impersonation: { sessionId: session.id } },
    });
    expect(
      await redeemImpersonationTicket({ auth, redis, token: adminToken, sessionId: session.id }),
    ).toMatchObject({
      tenantId: ids.supportTenant,
      userId: ids.actor,
      sub: 'administrator',
    });
    await expectMutationStatus(`/admin/impersonation/${session.id}/end`, { method: 'POST' });
    expect(notify).toHaveBeenCalledWith(
      { userId: ids.actor },
      'workspace.impersonated',
      expect.objectContaining({ state: 'ended' }),
      expect.anything(),
    );
    expect(
      (
        await api.request('/me', {
          headers: { authorization: `Bearer ${adminToken}`, 'x-impersonation-session': session.id },
        })
      ).status,
    ).toBe(403);
    await admin.db
      .update(tenants)
      .set({ status: 'deleting', deleteAfter: new Date(Date.now() + 86_400_000) })
      .where(eq(tenants.id, ids.supportTenant));
    await expectMutationStatus(`/admin/tenants/${ids.supportTenant}/cancel-deletion`, {
      method: 'POST',
    });
    const expiring = await adminMutation(`/admin/tenants/${ids.supportTenant}/impersonate`, {
      method: 'POST',
      body: JSON.stringify({ reason: 'Verify that an expired support session is rejected' }),
    });
    const expiredSession = ((await expiring.json()) as { session: { id: string } }).session;
    await admin.db
      .update(impersonationSessions)
      .set({
        startedAt: new Date(Date.now() - 7_200_000),
        expiresAt: new Date(Date.now() - 3_600_000),
      })
      .where(eq(impersonationSessions.id, expiredSession.id));
    expect(
      (
        await api.request('/me', {
          headers: {
            authorization: `Bearer ${adminToken}`,
            'x-impersonation-session': expiredSession.id,
          },
        })
      ).status,
    ).toBe(403);
  });

  test('enforces user gates, staff-only grants, and the final-administrator guard', async () => {
    expect(
      (
        await adminMutation(`/admin/users/${ids.actor}/memberships/${ids.tenant}`, {
          method: 'DELETE',
          body: '{}',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await adminMutation(`/admin/users/${ids.target}/disable`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'Compromised credentials' }),
        })
      ).status,
    ).toBe(200);
    const disabled = await api.request('/me', {
      headers: { authorization: `Bearer ${await sign('target')}` },
    });
    expect(disabled.status).toBe(403);
    expect(await disabled.json()).toMatchObject({ state: 'disabled' });
    expect(
      (await adminMutation(`/admin/users/${ids.target}/enable`, { method: 'POST', body: '{}' }))
        .status,
    ).toBe(200);
    const beforeCutoff = await sign('target', { issuedAt: Math.floor(Date.now() / 1_000) - 1 });
    expect(
      (
        await adminMutation(`/admin/users/${ids.target}/sign-out-everywhere`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(
      (await api.request('/me', { headers: { authorization: `Bearer ${beforeCutoff}` } })).status,
    ).toBe(401);
    const afterCutoff = await sign('target', { issuedAt: Math.floor(Date.now() / 1_000) + 1 });
    expect(
      (await api.request('/me', { headers: { authorization: `Bearer ${afterCutoff}` } })).status,
    ).toBe(200);
    expect(
      (
        await adminMutation(`/admin/users/${ids.rogue}/grant-admin`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await adminMutation(`/admin/users/${ids.target}/grant-admin`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await adminMutation(`/admin/users/${ids.target}/revoke-admin`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(200);
    await expect(
      grantAdminRole(appDb.db, { actorUserId: ids.actor, userId: ids.target }),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    await admin.db.delete(platformOperators).where(eq(platformOperators.userId, ids.rogue));
    const before = await auditCount();
    expect(
      (
        await adminMutation(`/admin/users/${ids.actor}/revoke-admin`, {
          method: 'POST',
          body: '{}',
        })
      ).status,
    ).toBe(409);
    expect(await auditCount()).toBe(before);
    expect(
      (
        await adminMutation(`/admin/users/${ids.actor}`, {
          method: 'DELETE',
          body: JSON.stringify({ reason: 'Attempt to remove the final administrator' }),
        })
      ).status,
    ).toBe(409);
  });

  test('invalidates provider verification, updates public policy, and tombstones attribution', async () => {
    await expectMutationStatus(
      `/admin/providers/${ids.staffProvider}`,
      {
        method: 'PUT',
        body: JSON.stringify({ issuer: 'http://identity.example.test' }),
      },
      400,
    );
    const providerUpdate = await adminMutation(`/admin/providers/${ids.staffProvider}`, {
      method: 'PUT',
      body: '{"emailClaim":"alternate_email","backchannelLogout":true}',
    });
    expect(await providerUpdate.json()).toMatchObject({ provider: { backchannelLogout: true } });
    expect(invalidate).toHaveBeenCalled();
    const adminToken = await sign('administrator');
    expect(
      await (
        await api.request('/me', { headers: { authorization: `Bearer ${adminToken}` } })
      ).json(),
    ).toMatchObject({ user: { email: 'alternate-administrator@example.test' } });
    expect(
      (
        await adminMutation('/admin/settings', {
          method: 'PUT',
          body: JSON.stringify({ key: 'REGISTRATION_MODE', value: 'closed' }),
        })
      ).status,
    ).toBe(200);
    expect(await (await api.request('/public-config')).json()).toMatchObject({
      registrationMode: 'closed',
    });
    expect(
      (
        await api.request('/foundings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
    const [incident] = await admin.db
      .insert(incidents)
      .values({
        tenantId: ids.tenant,
        fingerprint: `admin-${marker}`,
        alertSource: 'manual',
        service: 'identity',
        severity: 'sev3',
      })
      .returning();
    const [message] = await admin.db
      .insert(incidentMessages)
      .values({
        tenantId: ids.tenant,
        incidentId: incident!.id,
        author: 'human',
        content: 'Retained attribution',
        authorUserId: ids.target,
      })
      .returning();
    expect(
      (
        await adminMutation(`/admin/users/${ids.target}/memberships/${ids.tenant}`, {
          method: 'DELETE',
          body: '{}',
        })
      ).status,
    ).toBe(200);
    await expectMutationStatus(`/admin/users/${ids.target}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason: 'Requested account deletion' }),
    });
    expect(
      await admin.db
        .select({ status: users.status, email: users.email, subject: users.subject })
        .from(users)
        .where(eq(users.id, ids.target)),
    ).toEqual([{ status: 'deleted', email: null, subject: expect.stringMatching(/^deleted:/) }]);
    expect(
      await admin.db
        .select({ authorUserId: incidentMessages.authorUserId })
        .from(incidentMessages)
        .where(eq(incidentMessages.id, message!.id)),
    ).toEqual([{ authorUserId: ids.target }]);
  });
});
