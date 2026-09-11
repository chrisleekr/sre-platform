import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  createBrowserSession,
  getBrowserSession,
  identityProviders,
  makeDb,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
const marker = randomUUID();
const providerId = randomUUID();
const foundingId = randomUUID();
const founderId = randomUUID();
const issuer = `https://continuation-${marker}.example.test`;
let db: DbHandle;
beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Continuation directory',
    issuer,
    jwksUri: `${issuer}/jwks`,
    authorizationEndpoint: `${issuer}/authorize`,
    tokenEndpoint: `${issuer}/token`,
    audience: 'https://api.sre.example',
    browserClientId: 'browser-client',
    kind: 'oidc',
    scope: 'tenant',
    status: 'provisional',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  await db.db.insert(users).values({
    id: founderId,
    issuer,
    subject: 'founder-subject',
    email: 'founder@example.test',
  });
  await db.db.insert(workspaceFoundings).values({
    id: foundingId,
    path: 'own_directory',
    slug: `continuation-${marker}`,
    requestedName: 'Continuation workspace',
    providerId,
    founderUserId: founderId,
    declaredDomain: 'example.test',
    status: 'founder_authenticated',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.id, foundingId));
  await db.db.delete(users).where(eq(users.id, founderId));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.close();
});

async function credential(userId = founderId) {
  return (
    await createBrowserSession(db.db, {
      providerId,
      clientId: 'browser-client',
      userId,
      foundingId,
      oidcSubject: 'founder-subject',
      bindingClaimValue: null,
      authenticatedAt: new Date(),
      idleSeconds: 3600,
      absoluteSeconds: 86400,
    })
  ).credential;
}
test('restores the same founder through review, approval and a retryable provisioning failure', async () => {
  const cookie = await credential();
  for (const status of [
    'founder_authenticated',
    'pending',
    'approved',
    'provisioning',
    'failed',
  ] as const) {
    await db.db
      .update(workspaceFoundings)
      .set({ status })
      .where(eq(workspaceFoundings.id, foundingId));
    expect((await getBrowserSession(db.db, cookie, 3600))?.user.id).toBe(founderId);
  }
});
test('continues during independent DNS verification and after provider activation', async () => {
  const cookie = await credential();
  await db.db
    .update(identityProviders)
    .set({ status: 'pending_verification', expiresAt: null })
    .where(eq(identityProviders.id, providerId));
  await db.db
    .update(workspaceFoundings)
    .set({ status: 'active' })
    .where(eq(workspaceFoundings.id, foundingId));
  expect((await getBrowserSession(db.db, cookie, 3600))?.session.providerId).toBe(providerId);
  await db.db
    .update(identityProviders)
    .set({ status: 'active' })
    .where(eq(identityProviders.id, providerId));
  expect((await getBrowserSession(db.db, cookie, 3600))?.session.providerId).toBe(providerId);
});
test('does not let a different user inherit a provisional founder session', async () => {
  const otherId = randomUUID();
  await db.db.insert(users).values({ id: otherId, issuer, subject: 'other-subject' });
  try {
    await db.db
      .update(identityProviders)
      .set({ status: 'provisional' })
      .where(eq(identityProviders.id, providerId));
    expect(await getBrowserSession(db.db, await credential(otherId), 3600)).toBeNull();
  } finally {
    await db.db.delete(users).where(eq(users.id, otherId));
  }
});
test('does not restore an expired setup or disabled provider', async () => {
  const cookie = await credential();
  await db.db
    .update(workspaceFoundings)
    .set({ status: 'expired' })
    .where(eq(workspaceFoundings.id, foundingId));
  expect(await getBrowserSession(db.db, cookie, 3600)).toBeNull();
  await db.db
    .update(identityProviders)
    .set({ status: 'disabled' })
    .where(eq(identityProviders.id, providerId));
  expect(await getBrowserSession(db.db, cookie, 3600)).toBeNull();
});
