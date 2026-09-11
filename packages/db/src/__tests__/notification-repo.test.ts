import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  createNotification,
  listUserNotifications,
  makeDb,
  markAllNotificationsRead,
  markNotificationEmailFailed,
  markNotificationEmailed,
  markNotificationRead,
  notifications,
  tenants,
  users,
  type DbHandle,
} from '../index';

const marker = randomUUID();
const tenantId = randomUUID();
const firstUserId = randomUUID();
const secondUserId = randomUUID();
let db: DbHandle;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(tenants).values({
    id: tenantId,
    name: `Notifications ${marker}`,
    slug: `notifications-${marker}`,
  });
  await db.db.insert(users).values([
    {
      id: firstUserId,
      issuer: `https://notifications-${marker}.invalid`,
      subject: 'first',
      email: `first-${marker}@example.test`,
    },
    {
      id: secondUserId,
      issuer: `https://notifications-${marker}.invalid`,
      subject: 'second',
      email: `second-${marker}@example.test`,
    },
  ]);
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.db.delete(notifications).where(eq(notifications.tenantId, tenantId));
  await db.db.delete(users).where(inArray(users.id, [firstUserId, secondUserId]));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

describe('notification repository', () => {
  test('persists user and email-only recipients and coalesces one retried event', async () => {
    const first = await createNotification(db.db, {
      recipientUserId: firstUserId,
      tenantId,
      kind: 'invitation.created',
      payload: { workspaceName: 'Acme' },
      eventKey: `invite:${marker}`,
    });
    expect(first).toMatchObject({
      created: true,
      recipientEmail: `first-${marker}@example.test`,
      notification: { recipientUserId: firstUserId, recipientEmail: null },
    });

    const duplicate = await createNotification(db.db, {
      recipientUserId: firstUserId,
      tenantId,
      kind: 'invitation.created',
      payload: { workspaceName: 'Changed by retry' },
      eventKey: `invite:${marker}`,
    });
    expect(duplicate).toMatchObject({
      created: false,
      notification: { id: first.notification.id },
    });

    const emailOnly = await createNotification(db.db, {
      recipientEmail: `Invite-${marker}@Example.Test`,
      tenantId,
      kind: 'invitation.created',
      payload: {},
    });
    expect(emailOnly).toMatchObject({
      created: true,
      recipientEmail: `invite-${marker}@example.test`,
      notification: { recipientUserId: null, recipientEmail: `invite-${marker}@example.test` },
    });
  });

  test('keeps reads recipient-scoped, keyset paginated, and ownership-checked', async () => {
    await db.db.insert(notifications).values([
      ...Array.from({ length: 51 }, (_, index) => ({
        recipientUserId: firstUserId,
        tenantId,
        kind: 'account.signed_out',
        payload: { index },
      })),
      {
        recipientUserId: secondUserId,
        tenantId,
        kind: 'account.signed_out',
        payload: { private: true },
      },
    ]);

    const firstPage = await listUserNotifications(db.db, { userId: firstUserId, limit: 50 });
    expect(firstPage.notifications).toHaveLength(50);
    expect(firstPage.unreadCount).toBeGreaterThanOrEqual(52);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(firstPage.notifications.every((row) => row.recipientUserId === firstUserId)).toBe(true);

    const secondPage = await listUserNotifications(db.db, {
      userId: firstUserId,
      limit: 50,
      after: firstPage.nextCursor!,
    });
    expect(secondPage.notifications.length).toBeGreaterThanOrEqual(2);
    expect(
      new Set([...firstPage.notifications, ...secondPage.notifications].map((row) => row.id)).size,
    ).toBe(firstPage.notifications.length + secondPage.notifications.length);

    const privateRow = (await listUserNotifications(db.db, { userId: secondUserId, limit: 50 }))
      .notifications[0]!;
    await expect(markNotificationRead(db.db, firstUserId, privateRow.id)).resolves.toBe(false);
    await expect(
      markNotificationRead(db.db, firstUserId, firstPage.notifications[0]!.id),
    ).resolves.toBe(true);
    await markAllNotificationsRead(db.db, firstUserId);
    expect(
      (await listUserNotifications(db.db, { userId: firstUserId, limit: 50 })).unreadCount,
    ).toBe(0);
    expect(
      (await listUserNotifications(db.db, { userId: secondUserId, limit: 50 })).unreadCount,
    ).toBe(1);
  });

  test('records either the successful or failed secondary delivery outcome', async () => {
    const created = await createNotification(db.db, {
      recipientUserId: firstUserId,
      tenantId,
      kind: 'directory.verified',
      payload: {},
    });
    await markNotificationEmailed(db.db, created.notification.id);
    expect(
      await db.db
        .select({ emailedAt: notifications.emailedAt, emailError: notifications.emailError })
        .from(notifications)
        .where(eq(notifications.id, created.notification.id)),
    ).toEqual([{ emailedAt: expect.any(Date), emailError: null }]);

    const failed = await createNotification(db.db, {
      recipientEmail: `failure-${marker}@example.test`,
      tenantId,
      kind: 'directory.verified',
      payload: {},
    });
    await markNotificationEmailFailed(db.db, failed.notification.id, 'mailbox unavailable');
    expect(
      await db.db
        .select({ emailedAt: notifications.emailedAt, emailError: notifications.emailError })
        .from(notifications)
        .where(eq(notifications.id, failed.notification.id)),
    ).toEqual([{ emailedAt: null, emailError: 'mailbox unavailable' }]);
  });
});
