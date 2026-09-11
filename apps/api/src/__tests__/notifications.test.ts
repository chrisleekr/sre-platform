import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  makeDb,
  identityProviders,
  memberships,
  notifications,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import type { AuthDeps } from '../auth';
import { notificationRoutes } from '../notifications';
import { makeTestAuth } from './auth-test-support';

const marker = randomUUID();
const issuer = `https://notification-routes-${marker}.invalid`;
const tenantId = randomUUID();
const subjects = ['first', 'second'] as const;
let admin: DbHandle;
let appDb: DbHandle;
let auth: AuthDeps;
let privateKey: CryptoKey;
const userIds = [randomUUID(), randomUUID()];

async function sign(subject: string): Promise<string> {
  return new SignJWT({ sub: subject, email: `${subject}@example.test`, email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'notification-routes' })
    .setIssuer(issuer)
    .setAudience('sre-api')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'notification-routes';
  jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  await admin.db.insert(tenants).values({
    id: tenantId,
    name: `Notification routes ${marker}`,
    slug: `notification-routes-${marker}`,
  });
  await admin.db.insert(users).values(
    subjects.map((subject, index) => ({
      id: userIds[index]!,
      issuer,
      subject,
      email: `${subject}@example.test`,
    })),
  );
  auth = await makeTestAuth({
    adminDb: admin.db,
    appDb: appDb.db,
    issuer,
    audience: 'sre-api',
    keys,
    bindings: subjects.map((subject) => ({ tenantId, subject })),
  });
  await admin.db.insert(notifications).values([
    ...Array.from({ length: 51 }, (_, index) => ({
      recipientUserId: userIds[0]!,
      tenantId,
      kind: 'account.signed_out',
      payload: { index },
    })),
    {
      recipientUserId: userIds[1]!,
      tenantId,
      kind: 'account.disabled',
      payload: { private: true },
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  await admin.db.delete(notifications).where(eq(notifications.tenantId, tenantId));
  await admin.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await admin.db
    .delete(tenantIdentityBindings)
    .where(eq(tenantIdentityBindings.tenantId, tenantId));
  await admin.db.delete(users).where(inArray(users.id, userIds));
  await admin.db.delete(identityProviders).where(eq(identityProviders.issuer, issuer));
  await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
  await Promise.all([admin.close(), appDb.close()]);
});

describe('notification inbox API', () => {
  test('paginates only the authenticated recipient and reports the exact unread total', async () => {
    const api = notificationRoutes({ auth, db: appDb.db, appUrl: 'https://sre.example.test' });
    const authorization = `Bearer ${await sign('first')}`;
    const first = await api.request('/me/notifications', { headers: { authorization } });
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      notifications: Array<{ id: string; title: string; payload: Record<string, unknown> }>;
      unreadCount: number;
      nextCursor: string;
    };
    expect(page.notifications).toHaveLength(50);
    expect(page.notifications.every((row) => row.title === 'Sessions revoked')).toBe(true);
    expect(page.notifications.every((row) => !Object.hasOwn(row, 'recipientUserId'))).toBe(true);
    expect(page.unreadCount).toBe(51);
    expect(page.nextCursor).toEqual(expect.any(String));

    const next = await api.request(
      `/me/notifications?after=${encodeURIComponent(page.nextCursor)}`,
      {
        headers: { authorization },
      },
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as { notifications: unknown[] }).notifications).toHaveLength(1);
  });

  test('rejects malformed cursors and cannot mark another recipient notification read', async () => {
    const api = notificationRoutes({ auth, db: appDb.db, appUrl: 'https://sre.example.test' });
    const firstAuth = { authorization: `Bearer ${await sign('first')}` };
    expect(
      (await api.request('/me/notifications?after=not-a-cursor', { headers: firstAuth })).status,
    ).toBe(400);
    const second = await api.request('/me/notifications', {
      headers: { authorization: `Bearer ${await sign('second')}` },
    });
    const privateId = ((await second.json()) as { notifications: Array<{ id: string }> })
      .notifications[0]!.id;
    expect(
      (
        await api.request(`/me/notifications/${privateId}/read`, {
          method: 'POST',
          headers: firstAuth,
        })
      ).status,
    ).toBe(404);
  });

  test('marks one row and then every remaining row read for the caller only', async () => {
    const api = notificationRoutes({ auth, db: appDb.db, appUrl: 'https://sre.example.test' });
    const headers = { authorization: `Bearer ${await sign('first')}` };
    const list = await api.request('/me/notifications', { headers });
    const firstId = ((await list.json()) as { notifications: Array<{ id: string }> })
      .notifications[0]!.id;
    expect(
      (await api.request(`/me/notifications/${firstId}/read`, { method: 'POST', headers })).status,
    ).toBe(200);
    const all = await api.request('/me/notifications/read-all', { method: 'POST', headers });
    expect(all.status).toBe(200);
    expect((await all.json()) as { marked: number }).toEqual({ marked: 50 });
    const refreshed = await api.request('/me/notifications', { headers });
    expect(((await refreshed.json()) as { unreadCount: number }).unreadCount).toBe(0);
    const other = await api.request('/me/notifications', {
      headers: { authorization: `Bearer ${await sign('second')}` },
    });
    expect(((await other.json()) as { unreadCount: number }).unreadCount).toBe(1);
  });
});
