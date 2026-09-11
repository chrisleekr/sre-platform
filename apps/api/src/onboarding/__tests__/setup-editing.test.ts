import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  createOidcAttempt,
  identityProviders,
  makeDb,
  makePlatformSecretStore,
  oidcAttempts,
  platformSecrets,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { foundingRoutes } from '../foundings';
import { setupEditorCookie } from '../setup-editor-cookie';
import type { AuthDeps } from '../../auth';

let db: DbHandle;
const prefix = `editable-${randomUUID()}`;
const ids: string[] = [];
const providerIds: string[] = [];
beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});
afterAll(async () => {
  await db.db.delete(workspaceFoundings).where(like(workspaceFoundings.slug, `${prefix}%`));
  if (providerIds.length)
    await db.db.delete(identityProviders).where(inArray(identityProviders.id, providerIds));
  if (ids.length)
    await db.db
      .delete(platformSecrets)
      .where(
        inArray(platformSecrets.name, [
          ...ids.map((id) => `setup-editor:${id}`),
          ...providerIds.map((id) => `oidc-client:${id}`),
        ]),
      );
  await db.close();
});

async function fixture(
  secure = false,
  limiter: { allow(scope: string): Promise<boolean> } = { allow: async () => true },
) {
  const origin = `${secure ? 'https' : 'http'}://dashboard.example.test`;
  const secrets = makePlatformSecretStore(db.db, randomBytes(32).toString('base64'));
  const discovery = { calls: 0 };
  const app = new Hono().route(
    '/',
    foundingRoutes({
      auth: {} as AuthDeps,
      db: db.db,
      clientSecrets: secrets,
      setupEditor: setupEditorCookie(
        secrets,
        (c) => c.req.header('origin') === origin && c.req.header('x-sre-session') === '1',
        secure,
      ),
      registrationMode: async () => 'open',
      limiter,
      sourceAddress: () => 'test',
      oidc: {
        discover: async (issuer) => {
          discovery.calls++;
          return {
            issuer,
            authorizationEndpoint: `${issuer}/authorize`,
            tokenEndpoint: `${issuer}/token`,
            jwksUri: `${issuer}/jwks`,
          };
        },
      },
    }),
  );
  const input = {
    path: 'own_directory',
    slug: `${prefix}-${ids.length}`,
    requestedName: 'Editable workspace',
    declaredDomain: 'example.test',
    issuer: `https://${randomUUID()}.example.test`,
    clientId: 'incorrect-client',
    clientAuthentication: 'client_secret_post',
    clientSecret: 'original-secret',
  };
  const created = await app.request('/foundings', {
    method: 'POST',
    headers: { origin, 'x-sre-session': '1', 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  expect(created.status).toBe(201);
  const data = (await created.json()) as { founding: { id: string }; provider: { id: string } };
  ids.push(data.founding.id);
  providerIds.push(data.provider.id);
  const cookieHeader = created.headers.get('set-cookie')!;
  const cookie = cookieHeader.split(';')[0]!;
  async function request(body?: Record<string, unknown>, headers: Record<string, string> = {}) {
    return app.request(`/foundings/${data.founding.id}/draft`, {
      method: body ? 'PATCH' : 'GET',
      headers: {
        origin,
        'x-sre-session': '1',
        cookie,
        'content-type': 'application/json',
        ...headers,
      },
      ...(body
        ? { body: JSON.stringify({ ...input, providerId: data.provider.id, ...body }) }
        : {}),
    });
  }
  async function find(headers: Record<string, string> = {}) {
    return app.request(`/workspace-setup-drafts/${input.slug}`, {
      headers: { origin, 'x-sre-session': '1', cookie, ...headers },
    });
  }
  return { ...data, input, cookie, cookieHeader, request, find, secrets, discovery };
}

test.each([false, true])(
  'protects draft settings with the creating browser and exact origin (secure=%s)',
  async (secure) => {
    const f = await fixture(secure);
    expect(f.cookieHeader).toContain('HttpOnly');
    expect(f.cookieHeader).toContain('SameSite=Lax');
    if (secure) {
      expect(f.cookieHeader).toContain('__Host-');
      expect(f.cookieHeader).toContain('Secure');
    }
    expect(await f.secrets.get(`setup-editor:${f.founding.id}`)).not.toBe(f.cookie.split('=')[1]);
    const view = await (await f.request()).json();
    expect(view).toMatchObject({ clientId: 'incorrect-client', secretStored: true });
    expect(JSON.stringify(view)).not.toContain('original-secret');
    expect(await (await f.find()).json()).toMatchObject({
      foundingId: f.founding.id,
      providerId: f.provider.id,
      clientId: 'incorrect-client',
    });
    expect((await f.find({ origin: '' })).status).toBe(200);
    expect((await f.request(undefined, { origin: '' })).status).toBe(200);
    expect((await f.request({ requestedName: 'Blocked' }, { origin: '' })).status).toBe(403);
    expect((await f.find({ cookie: '' })).status).toBe(404);
    expect((await f.request(undefined, { cookie: '' })).status).toBe(403);
    expect(
      (await f.request({ clientId: 'attacker' }, { origin: 'https://attacker.example' })).status,
    ).toBe(403);
    expect((await f.request(undefined, { 'x-sre-session': '' })).status).toBe(403);
    const other = await fixture();
    expect((await f.request(undefined, { cookie: other.cookie })).status).toBe(403);
  },
);

test('replaces bad credentials on the same setup, removes old attempts and rejects stale edits', async () => {
  const f = await fixture();
  await createOidcAttempt(db.db, {
    browserHash: 'hash',
    providerId: f.provider.id,
    foundingId: f.founding.id,
    nonce: 'nonce',
    codeVerifier: 'verifier',
    redirectUri: 'http://dashboard.example.test/auth/callback',
    returnTo: '/get-started',
    expiresAt: new Date(Date.now() + 60000),
  });
  const response = await f.request({
    clientId: 'correct-client',
    clientSecret: 'replacement-secret',
  });
  expect(response.status).toBe(200);
  const changed = (await response.json()) as { providerId: string; foundingId: string };
  providerIds.push(changed.providerId);
  expect(changed.foundingId).toBe(f.founding.id);
  expect(changed.providerId).not.toBe(f.provider.id);
  expect(await f.secrets.get(`oidc-client:${changed.providerId}`)).toBe('replacement-secret');
  expect(await f.secrets.get(`oidc-client:${f.provider.id}`)).toBeNull();
  expect(
    await db.db.select().from(oidcAttempts).where(eq(oidcAttempts.foundingId, f.founding.id)),
  ).toHaveLength(0);
  expect((await f.request({ clientId: 'stale-change' })).status).toBe(409);
  expect(
    await db.db.select().from(workspaceFoundings).where(eq(workspaceFoundings.slug, f.input.slug)),
  ).toHaveLength(1);
});

test('keeps a secret only for the same registration and rejects editing after identity proof or expiry', async () => {
  const f = await fixture();
  expect(
    (await f.request({ clientId: 'different', keepSecret: true, clientSecret: undefined })).status,
  ).toBe(400);
  const kept = await f.request({
    requestedName: 'Correct name',
    keepSecret: true,
    clientSecret: undefined,
  });
  expect(kept.status).toBe(200);
  const changed = (await kept.json()) as { providerId: string };
  providerIds.push(changed.providerId);
  expect(await f.secrets.get(`oidc-client:${changed.providerId}`)).toBe('original-secret');
  await db.db
    .update(workspaceFoundings)
    .set({ status: 'authenticating_founder' })
    .where(eq(workspaceFoundings.id, f.founding.id));
  const submitted = await f.request();
  expect(submitted.status).toBe(409);
  expect(await submitted.json()).toMatchObject({
    code: 'setup_authentication_in_progress',
    providerId: changed.providerId,
  });
  await db.db
    .update(workspaceFoundings)
    .set({ status: 'pending' })
    .where(eq(workspaceFoundings.id, f.founding.id));
  const pending = await f.request();
  expect(pending.status).toBe(409);
  expect(await pending.json()).toMatchObject({
    code: 'setup_in_progress',
    providerId: changed.providerId,
  });
  await db.db
    .update(workspaceFoundings)
    .set({ status: 'awaiting_founder', expiresAt: new Date(0) })
    .where(eq(workspaceFoundings.id, f.founding.id));
  const expired = await f.request();
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ code: 'setup_expired' });
  expect((await f.request({ providerId: changed.providerId })).status).toBe(409);
});

test('reclaims only the targeted expired address when editing a live setup', async () => {
  const active = await fixture();
  const expired = await fixture();
  const unrelated = await fixture();
  await db.db
    .update(workspaceFoundings)
    .set({ expiresAt: new Date(Date.now() - 1_000) })
    .where(inArray(workspaceFoundings.id, [expired.founding.id, unrelated.founding.id]));

  const response = await active.request({ slug: expired.input.slug });
  expect(response.status).toBe(200);
  const changed = (await response.json()) as { providerId: string };
  providerIds.push(changed.providerId);
  expect(
    await db.db
      .select({ id: workspaceFoundings.id, status: workspaceFoundings.status })
      .from(workspaceFoundings)
      .where(inArray(workspaceFoundings.id, [expired.founding.id, unrelated.founding.id])),
  ).toEqual(
    expect.arrayContaining([
      { id: expired.founding.id, status: 'expired' },
      { id: unrelated.founding.id, status: 'awaiting_founder' },
    ]),
  );
});

test('rate-limits repeated discovery while preserving the editable setup', async () => {
  const f = await fixture(false, {
    allow: async (scope) => scope !== 'founding-discover',
  });
  const callsBeforeEdit = f.discovery.calls;

  const response = await f.request({ issuer: `https://${randomUUID()}.example.test` });
  expect(response.status).toBe(429);
  expect(f.discovery.calls).toBe(callsBeforeEdit);
  expect((await f.request()).status).toBe(200);
});
