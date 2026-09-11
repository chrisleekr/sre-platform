import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { makeDb, notifications, tenants, users, type DbHandle } from '@sre/db';
import { makeNotifier, renderNotification, type EmailAdapter } from '../index';

const marker = randomUUID();
const tenantId = randomUUID();
const userId = randomUUID();
let db: DbHandle;

beforeAll(async () => {
  expect(process.env.SRE_TEST_INFRA).toBe('testcontainers');
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(tenants).values({
    id: tenantId,
    name: `Notifier ${marker}`,
    slug: `notifier-${marker}`,
  });
  await db.db.insert(users).values({
    id: userId,
    issuer: `https://notifier-${marker}.invalid`,
    subject: 'recipient',
    email: `recipient-${marker}@example.test`,
  });
}, 30_000);

afterAll(async () => {
  if (!db) return;
  await db.db.delete(notifications).where(eq(notifications.tenantId, tenantId));
  await db.db.delete(users).where(inArray(users.id, [userId]));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

function notifier(email: () => Promise<EmailAdapter | null>) {
  return makeNotifier({
    db: db.db,
    email,
    appUrl: 'https://sre.example.test',
    log: { error: vi.fn() },
  });
}

describe('Notifier', () => {
  test('completes at the durable inbox row when SMTP is absent', async () => {
    await expect(
      notifier(async () => null).notify(
        { userId },
        'directory.verified',
        { domain: 'example.test' },
        { tenantId, eventKey: `no-smtp:${marker}` },
      ),
    ).resolves.toBeUndefined();

    expect(
      await db.db
        .select({ emailedAt: notifications.emailedAt, emailError: notifications.emailError })
        .from(notifications)
        .where(eq(notifications.eventKey, `no-smtp:${marker}`)),
    ).toEqual([{ emailedAt: null, emailError: null }]);
  });

  test('records successful email and does not redeliver a retried event', async () => {
    const send = vi.fn(async () => undefined);
    const service = notifier(async () => ({ send }));
    const deliver = () =>
      service.notify(
        { userId },
        'workspace.ownership_transferred',
        { workspaceName: 'Acme' },
        { tenantId, eventKey: `ownership:${marker}` },
      );
    await deliver();
    await deliver();

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ to: `recipient-${marker}@example.test` }),
    );
    expect(
      await db.db
        .select({ emailedAt: notifications.emailedAt, emailError: notifications.emailError })
        .from(notifications)
        .where(eq(notifications.eventKey, `ownership:${marker}`)),
    ).toEqual([{ emailedAt: expect.any(Date), emailError: null }]);
  });

  test('stores an adapter failure and still resolves the caller', async () => {
    await expect(
      notifier(async () => ({
        send: async () => {
          throw new Error('relay refused');
        },
      })).notify(
        { email: `external-${marker}@example.test` },
        'invitation.created',
        {},
        { tenantId, eventKey: `failure:${marker}` },
      ),
    ).resolves.toBeUndefined();

    expect(
      await db.db
        .select({ recipientUserId: notifications.recipientUserId, error: notifications.emailError })
        .from(notifications)
        .where(eq(notifications.eventKey, `failure:${marker}`)),
    ).toEqual([{ recipientUserId: null, error: 'relay refused' }]);
  });

  test('does not promise email when the channel is absent', () => {
    const rendered = renderNotification(
      'founding.approved',
      { workspaceName: 'Acme' },
      {
        app: 'https://sre.example.test',
        emailAvailable: false,
      },
    );
    expect(rendered.text).not.toMatch(/by email/i);
    expect(rendered.href).toBe('https://sre.example.test/');
  });

  test('links workspace lifecycle events to a page every member can open', () => {
    expect(
      renderNotification(
        'directory.verified',
        { workspaceName: 'Acme', domain: 'example.test' },
        { app: 'https://sre.example.test', emailAvailable: false },
      ).href,
    ).toBe('https://sre.example.test/w');
  });
});
