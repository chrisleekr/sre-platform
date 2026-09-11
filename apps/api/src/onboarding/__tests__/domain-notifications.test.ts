import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  identityProviderDomains,
  identityProviders,
  makeDb,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { notifyDomainLifecycle } from '../domain-notifications';
import type { Notifier } from '@sre/notifications';

const marker = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
const domainId = randomUUID();
const ownerIds = [randomUUID(), randomUUID()];
const memberId = randomUUID();
const notify = vi.fn<Notifier['notify']>(async () => undefined);
let db: DbHandle;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(tenants).values({
    id: tenantId,
    name: `Directory notifications ${marker}`,
    slug: `directory-notifications-${marker}`,
  });
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Test directory',
    issuer: `https://directory-notifications-${marker}.invalid`,
    jwksUri: `https://directory-notifications-${marker}.invalid/jwks`,
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'tenant',
    status: 'pending_verification',
  });
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await db.db.insert(identityProviderDomains).values({
    id: domainId,
    providerId,
    domain: 'example.test',
    status: 'pending',
    expiresAt: new Date(Date.now() + 23 * 60 * 60 * 1_000),
  });
  await db.db.insert(users).values(
    [...ownerIds, memberId].map((id, index) => ({
      id,
      issuer: `https://directory-notifications-${marker}.invalid`,
      subject: `user-${index}`,
    })),
  );
  await db.db
    .insert(memberships)
    .values([
      ...ownerIds.map((userId) => ({ tenantId, userId, role: 'owner' as const })),
      { tenantId, userId: memberId, role: 'member' as const },
    ]);
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await db.db.delete(identityProviderDomains).where(eq(identityProviderDomains.id, domainId));
  await db.db.delete(tenantIdentityBindings).where(eq(tenantIdentityBindings.tenantId, tenantId));
  await db.db.delete(users).where(inArray(users.id, [...ownerIds, memberId]));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

describe('directory lifecycle notifications', () => {
  test('notifies only owners for the expiring and verified events', async () => {
    await notifyDomainLifecycle(db.db, { notify }, domainId, 'pending');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(ownerIds.map((userId) => ({ userId }))),
    );
    expect(notify.mock.calls.every((call) => call[1] === 'directory.expiring')).toBe(true);

    notify.mockClear();
    await notifyDomainLifecycle(db.db, { notify }, domainId, 'verified');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.every((call) => call[1] === 'directory.verified')).toBe(true);
  });
});
