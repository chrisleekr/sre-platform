import { randomBytes, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  browserCredentialHash,
  browserSessions,
  identityProviders,
  identityProviderDomains,
  mailboxProofs,
  makeDb,
  makePlatformSecretStore,
  platformSecrets,
  users,
  workspaceFoundings,
  tenantIdentityBindings,
  tenants,
  memberships,
  type DbHandle,
} from '@sre/db';
import { makeProviderVerifiers } from '../../auth/providers';
import type { AuthDeps, AuthVariables } from '../../auth';
import { makeBrowserSessionRuntime } from '../browser-session-runtime';
import { browserSessionRoutes } from '../browser-session-routes';
import { meRoutes } from '../me';
import { authDiscoveryRoutes } from '../auth-discover';
import { withFoundingRetirementRace } from './browser-session-recovery-race';
import { permissivePublicMetering } from './public-discovery-metering';

let db: DbHandle;
const fixtureProviders: string[] = [];
const fixtureTenants: string[] = [];
const fixtureSecretNames: string[] = [];
beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});
afterAll(async () => {
  if (fixtureSecretNames.length > 0)
    await db.db.delete(platformSecrets).where(inArray(platformSecrets.name, fixtureSecretNames));
  for (const tenantId of fixtureTenants)
    await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  for (const providerId of fixtureProviders) {
    await db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.providerId, providerId));
    await db.db
      .delete(identityProviderDomains)
      .where(eq(identityProviderDomains.providerId, providerId));
    await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
    await db.db
      .delete(mailboxProofs)
      .where(sql`${mailboxProofs.identity}->>'providerId' = ${providerId}`);
    await db.db
      .delete(users)
      .where(eq(users.issuer, `https://directory-${providerId}.example.test`));
  }
  await db?.close();
});

async function fixture(production = false) {
  const providerId = randomUUID();
  fixtureProviders.push(providerId);
  const issuer = `https://directory-${providerId}.example.test`;
  const dashboard = `${production ? 'https' : 'http'}://dashboard.example.test`;
  const prefix = production ? '__Host-' : '';
  const codes: string[] = [];
  let emailVerified = true;
  let subject = 'owner';
  const [user] = await db.db
    .insert(users)
    .values({ issuer, subject: 'owner', email: 'owner@example.test' })
    .returning();
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Directory',
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    browserClientId: 'browser-client',
    audience: null,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  const auth: AuthDeps = {
    db: db.db,
    adminDb: db.db,
    verifiers: makeProviderVerifiers(db.db),
    settings: { get: async () => 86400 },
    revoke: { publish: async () => {} },
  };
  const deps = {
    db: db.db,
    auth,
    secrets: makePlatformSecretStore(db.db, randomBytes(32).toString('base64')),
    dashboardUrl: dashboard,
    production,
    setting: async () => 86400,
    email: async () => ({
      send: async ({ text }: { text: string }) => {
        codes.push(text.match(/\b\d{8}\b/)![0]);
      },
    }),
    exchange: async () => ({
      issuer,
      subject,
      oidcSubject: 'owner',
      email: 'owner@example.test',
      emailVerified,
      authenticatedAt: new Date(),
      bindingClaimValue: null,
    }),
  };
  const runtime = makeBrowserSessionRuntime(deps);
  auth.browserSession = runtime.resolve;
  const app = new Hono<{ Variables: AuthVariables }>()
    .route('/', authDiscoveryRoutes({ db: db.db, ...permissivePublicMetering }))
    .route(
      '/',
      browserSessionRoutes(runtime, { allow: async () => true }, () => '203.0.113.1'),
    )
    .route('/', meRoutes({ auth, db: db.db }));
  // Browser time advances independently, while database expiry remains authoritative on the server.
  let now = Date.now();
  const cookies = new Map<string, { value: string; expiresAt: number }>();
  async function request(path: string, body?: unknown) {
    const response = await app.request(`https://api.example.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        origin: dashboard,
        'x-sre-session': '1',
        'content-type': 'application/json',
        'x-forwarded-proto': 'http',
        forwarded: 'proto=http;host=attacker.example',
        cookie: [...cookies]
          .filter(([, cookie]) => cookie.expiresAt > now)
          .map(([name, cookie]) => `${name}=${cookie.value}`)
          .join('; '),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair, ...attributes] = header.split(';').map((value) => value.trim());
      const separator = pair!.indexOf('=');
      const maxAge = attributes.find((value) => /^max-age=/i.test(value));
      const expires = attributes.find((value) => /^expires=/i.test(value));
      cookies.set(pair!.slice(0, separator), {
        value: pair!.slice(separator + 1),
        expiresAt: maxAge
          ? now + Number(maxAge.split('=')[1]) * 1000
          : expires
            ? Date.parse(expires.slice(8))
            : Infinity,
      });
    }
    return response;
  }
  async function signIn(foundingId?: string, selectedProviderId = providerId) {
    const start = await request('/auth/browser/start', {
      providerId: selectedProviderId,
      foundingId,
    });
    if (start.status !== 200) return start;
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    return request('/auth/browser/complete', {
      state: new URL(authorizationUrl).searchParams.get('state'),
      code: 'verified-upstream-code',
    });
  }
  async function founding(
    status: 'active' | 'founder_authenticated' | 'expired' = 'active',
    expiresAt = new Date(Date.now() + 3600000),
  ) {
    const id = randomUUID();
    await db.db.insert(workspaceFoundings).values({
      id,
      path: 'own_directory',
      providerId,
      founderUserId: user!.id,
      slug: `workspace-${id}`,
      requestedName: 'Workspace',
      declaredDomain: 'example.test',
      status,
      expiresAt,
    });
    await db.db
      .update(identityProviders)
      .set({ status: 'pending_verification' })
      .where(eq(identityProviders.id, providerId));
    return id;
  }
  async function duplicateFounding() {
    const duplicateProviderId = randomUUID();
    fixtureProviders.push(duplicateProviderId);
    await db.db.insert(identityProviders).values({
      id: duplicateProviderId,
      displayName: 'Duplicate directory',
      issuer,
      jwksUri: `${issuer}/jwks`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      browserClientId: 'browser-client',
      audience: null,
      kind: 'oidc',
      scope: 'tenant',
      status: 'provisional',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const duplicateFoundingId = randomUUID();
    await db.db.insert(workspaceFoundings).values({
      id: duplicateFoundingId,
      path: 'own_directory',
      providerId: duplicateProviderId,
      slug: `duplicate-${duplicateFoundingId}`,
      requestedName: 'Duplicate workspace',
      declaredDomain: 'example.test',
      status: 'awaiting_founder',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const secretNames = [
      `oidc-client:${duplicateProviderId}`,
      `setup-editor:${duplicateFoundingId}`,
    ];
    fixtureSecretNames.push(...secretNames);
    await deps.secrets.put(secretNames[0]!, 'duplicate-client-secret');
    await deps.secrets.put(secretNames[1]!, 'duplicate-editor-secret');
    return { providerId: duplicateProviderId, foundingId: duplicateFoundingId };
  }
  return {
    deps,
    request,
    signIn,
    founding,
    duplicateFounding,
    cookies,
    prefix,
    codes,
    providerId,
    userId: user!.id,
    anotherPerson: () => {
      subject = 'another-person';
    },
    unverified: () => {
      emailVerified = false;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function expectDuplicateSetup(foundingId: string, providerId: string) {
  expect(await duplicateSetupState(foundingId, providerId)).toEqual({
    foundingStatus: 'awaiting_founder',
    foundingProviderId: providerId,
    providerCount: 1,
    secretCount: 2,
  });
}

async function duplicateSetupState(foundingId: string, providerId: string) {
  const [row] = await db.db.execute<{
    foundingStatus: string;
    foundingProviderId: string | null;
    providerCount: number;
    secretCount: number;
  }>(sql`
    select f.status as "foundingStatus", f.provider_id as "foundingProviderId",
      (select count(*)::int from identity_providers where id = ${providerId}) as "providerCount",
      (select count(*)::int from platform_secrets where name in (
        ${`oidc-client:${providerId}`}, ${`setup-editor:${foundingId}`}
      )) as "secretCount"
    from workspace_foundings f where f.id = ${foundingId}
  `);
  return row;
}

describe('browser setup recovery', () => {
  async function provisionedWorkspace(
    f: Awaited<ReturnType<typeof fixture>>,
    providerStatus: 'pending_verification' | 'active' = 'pending_verification',
  ) {
    const foundingId = await f.founding('active', new Date(Date.now() - 3600000));
    const tenantId = randomUUID();
    fixtureTenants.push(tenantId);
    const slug = `workspace-${tenantId}`;
    await db.db.insert(tenants).values({ id: tenantId, slug, name: 'Workspace', status: 'active' });
    await db.db
      .insert(tenantIdentityBindings)
      .values({ tenantId, providerId: f.providerId, claimValue: null });
    await db.db
      .insert(identityProviderDomains)
      .values({ providerId: f.providerId, domain: 'example.test', status: 'pending' });
    await db.db
      .insert(memberships)
      .values({ tenantId, userId: f.userId, role: 'owner', status: 'active' });
    await db.db
      .update(workspaceFoundings)
      .set({ tenantId })
      .where(eq(workspaceFoundings.id, foundingId));
    await db.db
      .update(identityProviders)
      .set({ status: providerStatus })
      .where(eq(identityProviders.id, f.providerId));
    return { tenantId, foundingId, slug };
  }

  test('public workspace address offers owner-only recovery before DNS without enabling normal methods', async () => {
    const f = await fixture();
    const workspace = await provisionedWorkspace(f);
    const response = await f.request(`/workspaces/${workspace.slug}/sign-in-methods`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      methods: unknown[];
      setup: { foundingId: string; provider: { providerId: string } };
    };
    expect(result.methods).toEqual([]);
    expect(result.setup).toMatchObject({
      foundingId: workspace.foundingId,
      provider: { providerId: f.providerId },
    });
    expect(JSON.stringify(result)).not.toContain('owner@example.test');
    expect((await f.signIn(result.setup.foundingId)).status).toBe(200);
    expect(await (await f.request('/me')).json()).toMatchObject({
      tenant: { id: workspace.tenantId, role: 'owner' },
    });
    await f.request('/auth/browser/logout', {});
    f.anotherPerson();
    expect((await f.signIn(result.setup.foundingId)).status).toBe(400);
    expect(await (await f.request('/auth/browser/session')).json()).toEqual({
      authenticated: false,
    });
    expect((await f.request('/me')).status).toBe(401);
  });
  test.each(['pending_verification', 'active'] as const)(
    'returns the verified founder to an existing %s workspace before retiring a duplicate setup',
    async (providerStatus) => {
      const f = await fixture();
      const workspace = await provisionedWorkspace(f, providerStatus);
      const duplicate = await f.duplicateFounding();

      const response = await f.signIn(duplicate.foundingId, duplicate.providerId);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        foundingId: providerStatus === 'active' ? null : workspace.foundingId,
      });
      expect(await (await f.request('/me')).json()).toMatchObject({
        tenant: { id: workspace.tenantId, role: 'owner' },
      });
      expect(await duplicateSetupState(duplicate.foundingId, duplicate.providerId)).toEqual({
        foundingStatus: 'expired',
        foundingProviderId: null,
        providerCount: 0,
        secretCount: 0,
      });
    },
  );
  test.each([
    ['another directory account', 'subject', 'directory_already_connected'],
    ['disabled founder account', 'account', 'account_unavailable'],
    ['removed founder membership', 'membership', 'directory_already_connected'],
    ['different subject claim', 'claim', 'directory_already_connected'],
  ] as const)(
    'refuses %s without consuming the duplicate setup',
    async (_, scenario, expectedCode) => {
      const f = await fixture();
      const workspace = await provisionedWorkspace(f, 'active');
      const duplicate = await f.duplicateFounding();
      if (scenario === 'subject') f.anotherPerson();
      else if (scenario === 'account')
        await db.db.update(users).set({ status: 'disabled' }).where(eq(users.id, f.userId));
      else if (scenario === 'membership')
        await db.db
          .update(memberships)
          .set({ status: 'removed' })
          .where(
            sql`${memberships.tenantId} = ${workspace.tenantId} and ${memberships.userId} = ${f.userId}`,
          );
      else
        await db.db
          .update(identityProviders)
          .set({ subjectClaim: 'oid' })
          .where(eq(identityProviders.id, duplicate.providerId));

      const response = await f.signIn(duplicate.foundingId, duplicate.providerId);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: expectedCode });
      expect(await (await f.request('/auth/browser/session')).json()).toEqual({
        authenticated: false,
      });
      await expectDuplicateSetup(duplicate.foundingId, duplicate.providerId);
    },
  );
  test('revokes the recovered session when duplicate retirement loses a race', async () => {
    const f = await fixture();
    await provisionedWorkspace(f, 'active');
    const duplicate = await f.duplicateFounding();
    const response = await withFoundingRetirementRace(
      db.db,
      { providerId: f.providerId, foundingId: duplicate.foundingId },
      () => f.signIn(duplicate.foundingId, duplicate.providerId),
    );
    expect(await response.json()).toMatchObject({ code: 'setup_recovery_failed' });
    const sessions = await db.db
      .select({ revokedAt: browserSessions.revokedAt })
      .from(browserSessions)
      .where(eq(browserSessions.userId, f.userId));
    expect(sessions).toEqual([expect.objectContaining({ revokedAt: expect.any(Date) })]);
    expect(await duplicateSetupState(duplicate.foundingId, duplicate.providerId)).toMatchObject({
      foundingStatus: 'pending',
      providerCount: 1,
      secretCount: 2,
    });
  });
  test.each(['expired', 'disabled', 'wrong-workspace'] as const)(
    'hides setup recovery for %s association',
    async (invalid) => {
      const f = await fixture();
      const workspace = await provisionedWorkspace(f);
      if (invalid === 'expired')
        await db.db
          .update(workspaceFoundings)
          .set({ status: 'expired' })
          .where(eq(workspaceFoundings.id, workspace.foundingId));
      if (invalid === 'disabled')
        await db.db
          .update(identityProviders)
          .set({ status: 'disabled' })
          .where(eq(identityProviders.id, f.providerId));
      if (invalid === 'wrong-workspace')
        await db.db
          .update(workspaceFoundings)
          .set({ tenantId: null })
          .where(eq(workspaceFoundings.id, workspace.foundingId));
      expect(
        await (await f.request(`/workspaces/${workspace.slug}/sign-in-methods`)).json(),
      ).toMatchObject({ methods: [], setup: null });
    },
  );
  test('fresh sign-in before DNS retains the founder association and authenticates session and me', async () => {
    const f = await fixture();
    const foundingId = await f.founding();
    expect((await f.signIn(foundingId)).status).toBe(200);
    expect(await (await f.request('/auth/browser/session')).json()).toMatchObject({
      authenticated: true,
      foundingId,
    });
    expect((await f.request('/me')).status).toBe(200);
  });
  test('defaults a founding sign-in continuation to the canonical setup page', async () => {
    const f = await fixture();
    const foundingId = await f.founding();
    const start = await f.request('/auth/browser/start', {
      providerId: f.providerId,
      foundingId,
    });
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    const complete = await f.request('/auth/browser/complete', {
      state: new URL(authorizationUrl).searchParams.get('state'),
      code: 'verified-upstream-code',
    });

    expect(await complete.json()).toMatchObject({ returnTo: '/get-started', foundingId });
  });
  test('provisioned setup survives its original deadline for existing cookies and fresh sign-in', async () => {
    const f = await fixture();
    const foundingId = await f.founding('founder_authenticated');
    expect((await f.signIn(foundingId)).status).toBe(200);
    await db.db
      .update(workspaceFoundings)
      .set({ status: 'active', expiresAt: new Date(Date.now() - 3600000) })
      .where(eq(workspaceFoundings.id, foundingId));
    expect(await (await f.request('/auth/browser/session')).json()).toMatchObject({
      authenticated: true,
      foundingId,
    });
    expect((await f.request('/me')).status).toBe(200);
    await f.request('/auth/browser/logout', {});
    expect((await f.signIn(foundingId)).status).toBe(200);
    expect(await (await f.request('/auth/browser/session')).json()).toMatchObject({
      authenticated: true,
      foundingId,
    });
    expect((await f.request('/me')).status).toBe(200);
  });
  test.each(['expired', 'founder_authenticated'] as const)(
    'still rejects %s setup past its deadline',
    async (status) => {
      const f = await fixture();
      const foundingId = await f.founding(status, new Date(0));
      expect((await f.signIn(foundingId)).status).toBe(400);
      expect(await (await f.request('/auth/browser/session')).json()).toEqual({
        authenticated: false,
      });
    },
  );
  test('resend refreshes cookie lifetime so the replacement code survives the original cookie deadline', async () => {
    const f = await fixture();
    f.unverified();
    expect((await f.signIn()).status).toBe(200);
    f.advance(9 * 60000);
    await db.db
      .update(mailboxProofs)
      .set({ lastSentAt: new Date(Date.now() - 61000) })
      .where(
        eq(
          mailboxProofs.credentialHash,
          browserCredentialHash(f.cookies.get('sre-mailbox-proof')!.value),
        ),
      );
    const resend = await f.request('/auth/browser/resend-email', {});
    expect(resend.status).toBe(200);
    f.advance(2 * 60000);
    expect((await f.request('/auth/browser/verify-email', { code: f.codes.at(-1) })).status).toBe(
      200,
    );
    expect(await (await f.request('/auth/browser/session')).json()).toMatchObject({
      authenticated: true,
    });
  });
  test('provisioned setup still requires its original owner and a permitted provider', async () => {
    const f = await fixture();
    const foundingId = await f.founding();
    await db.db
      .update(workspaceFoundings)
      .set({ founderUserId: null })
      .where(eq(workspaceFoundings.id, foundingId));
    expect((await f.signIn(foundingId)).status).toBe(400);
    await db.db
      .update(identityProviders)
      .set({ status: 'disabled' })
      .where(eq(identityProviders.id, f.providerId));
    expect((await f.signIn(foundingId)).status).toBe(400);
  });
});

describe('production browser cookie policy', () => {
  function assertCookie(response: Response, name: string, deletion = false) {
    const header = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`__Host-${name}=`));
    expect(header).toBeDefined();
    for (const attribute of ['Secure', 'HttpOnly', 'Path=/', 'SameSite=Lax'])
      expect(header).toContain(attribute);
    expect(header).not.toMatch(/domain=/i);
    if (deletion) expect(header).toContain('Max-Age=0');
  }
  test('requires HTTPS dashboard configuration before accepting any browser requests', async () => {
    const f = await fixture(true);
    expect(() =>
      makeBrowserSessionRuntime({ ...f.deps, dashboardUrl: 'http://dashboard.example.test' }),
    ).toThrow('HTTPS dashboard URL');
  });
  test('retains host-only Secure policy through attempts, mailbox resend, sessions and logout despite forwarded HTTP headers', async () => {
    const f = await fixture(true);
    f.unverified();
    const start = await f.request('/auth/browser/start', { providerId: f.providerId });
    expect(start.status).toBe(200);
    assertCookie(start, 'sre-oidc-browser');
    const { authorizationUrl } = (await start.json()) as { authorizationUrl: string };
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
      'https://dashboard.example.test/auth/callback',
    );
    const complete = await f.request('/auth/browser/complete', {
      state: new URL(authorizationUrl).searchParams.get('state'),
      code: 'verified-upstream-code',
    });
    expect(complete.status).toBe(200);
    assertCookie(complete, 'sre-mailbox-proof');
    const credential = f.cookies.get('__Host-sre-mailbox-proof')!.value;
    await db.db
      .update(mailboxProofs)
      .set({ lastSentAt: new Date(Date.now() - 61000) })
      .where(eq(mailboxProofs.credentialHash, browserCredentialHash(credential)));
    const resent = await f.request('/auth/browser/resend-email', {});
    expect(resent.status).toBe(200);
    assertCookie(resent, 'sre-mailbox-proof');
    const timing = (await resent.json()) as { expiresAt: number; resendAt: number };
    const [proof] = await db.db
      .select()
      .from(mailboxProofs)
      .where(eq(mailboxProofs.credentialHash, browserCredentialHash(credential)));
    expect(timing).toEqual({
      expiresAt: proof!.expiresAt.getTime(),
      resendAt: proof!.lastSentAt.getTime() + 60000,
    });
    const verified = await f.request('/auth/browser/verify-email', { code: f.codes.at(-1) });
    expect(verified.status).toBe(200);
    assertCookie(verified, 'sre-session');
    assertCookie(verified, 'sre-mailbox-proof', true);
    const logout = await f.request('/auth/browser/logout', {});
    expect(logout.status).toBe(200);
    assertCookie(logout, 'sre-session', true);
    expect(await (await f.request('/auth/browser/session')).json()).toEqual({
      authenticated: false,
    });
  });
});
