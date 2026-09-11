import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { identityProviders, makeDb, workspaceFoundings, type DbHandle } from '@sre/db';
import type { AuthDeps } from '../../auth';
import { foundingRoutes } from '../foundings';

const marker = randomUUID();
const issuer = `https://normal-${marker}.example.test`;
const clientId = `browser-${marker}`;
const declaredDomain = `${marker}.example.test`;
let db: DbHandle;

beforeAll(() => {
  db = makeDb(process.env.DATABASE_URL!);
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(workspaceFoundings)
    .where(eq(workspaceFoundings.declaredDomain, declaredDomain));
  await db.db.delete(identityProviders).where(eq(identityProviders.browserClientId, clientId));
  await db.close();
});

test('registers a normal OIDC client without an API access-token audience', async () => {
  const discover = vi.fn(async () => ({
    issuer,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    jwksUri: `${issuer}/jwks`,
  }));
  const auth = {
    verifiers: {
      byIssuer: async () => undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
  } as unknown as AuthDeps;
  const api = new Hono().route(
    '/',
    foundingRoutes({
      auth,
      db: db.db,
      registrationMode: async () => 'approval_required',
      limiter: { allow: async () => true },
      sourceAddress: () => '203.0.113.10',
      oidc: { discover },
    } as never),
  );

  const response = await api.request('/foundings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: 'own_directory',
      slug: `normal-${marker}`,
      requestedName: 'Normal OIDC workspace',
      declaredDomain,
      issuer,
      clientId,
      clientAuthentication: 'none',
    }),
  });

  expect(response.status).toBe(201);
  expect(discover).toHaveBeenCalledWith(issuer);
  expect(await response.json()).toMatchObject({
    founding: { status: 'awaiting_founder' },
    provider: { issuer, browserClientId: clientId },
  });
});
