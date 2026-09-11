import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { adminActions, identityProviders, makeDb, users, type DbHandle } from '@sre/db';
import type { AuthDeps, AuthVariables } from '../../auth';
import type { AdminRoutesDeps } from '../contracts';
import { adminProviderRoutes } from '../providers';

const actorId = randomUUID();
const providerId = randomUUID();
const issuer = `https://admin-logout-${randomUUID()}.provider.invalid/`;
const invalidate = vi.fn();
let db: DbHandle;
let api: Hono<{ Variables: AuthVariables }>;

function update(body: unknown) {
  return api.request(`/providers/${providerId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(users).values({
    id: actorId,
    issuer,
    subject: 'administrator',
    email: 'administrator@example.test',
  });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Administrative directory',
    issuer,
    jwksUri: `${issuer}.well-known/jwks.json`,
    browserClientId: 'browser-client',
    kind: 'oidc',
    scope: 'installation',
    status: 'active',
  });
  const auth: AuthDeps = {
    verifiers: {
      byIssuer: async () => undefined,
      forFounding: async () => undefined,
      invalidate,
    },
    db: db.db,
    adminDb: db.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
  const deps: AdminRoutesDeps = {
    auth,
    appDb: db.db,
    controlDb: db.db,
    settings: {} as AdminRoutesDeps['settings'],
  };
  api = new Hono<{ Variables: AuthVariables }>();
  api.use('*', async (c, next) => {
    c.set('user', {
      userId: actorId,
      issuer,
      subject: 'administrator',
      providerId,
      issuedAt: Math.floor(Date.now() / 1_000),
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
    });
    await next();
  });
  api.route('/providers', adminProviderRoutes(deps));
});

beforeEach(async () => {
  invalidate.mockClear();
  await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorId));
  await db.db
    .update(identityProviders)
    .set({
      browserClientId: 'browser-client',
      backchannelLogout: false,
      backchannelLogoutTypRequired: false,
    })
    .where(eq(identityProviders.id, providerId));
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(adminActions).where(eq(adminActions.actorUserId, actorId));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(users).where(inArray(users.id, [actorId]));
  await db.close();
});

test('rejects enabling logout while explicitly clearing the browser client', async () => {
  const response = await update({ backchannelLogout: true, browserClientId: null });

  expect(response.status).toBe(400);
  expect(invalidate).not.toHaveBeenCalled();
  expect(
    await db.db
      .select({
        browserClientId: identityProviders.browserClientId,
        backchannelLogout: identityProviders.backchannelLogout,
      })
      .from(identityProviders)
      .where(eq(identityProviders.id, providerId)),
  ).toEqual([{ browserClientId: 'browser-client', backchannelLogout: false }]);
});

test('rejects clearing the browser client while logout remains enabled', async () => {
  expect(
    (
      await update({
        backchannelLogout: true,
        backchannelLogoutTypRequired: true,
      })
    ).status,
  ).toBe(200);
  invalidate.mockClear();

  const response = await update({ browserClientId: null });

  expect(response.status).toBe(400);
  expect(invalidate).not.toHaveBeenCalled();
  expect(
    await db.db
      .select({
        browserClientId: identityProviders.browserClientId,
        backchannelLogout: identityProviders.backchannelLogout,
        typRequired: identityProviders.backchannelLogoutTypRequired,
      })
      .from(identityProviders)
      .where(eq(identityProviders.id, providerId)),
  ).toEqual([{ browserClientId: 'browser-client', backchannelLogout: true, typRequired: true }]);
});
