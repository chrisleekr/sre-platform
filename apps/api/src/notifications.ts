import {
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Db,
  type NotificationCursor,
} from '@sre/db';
import { NOTIFICATION_KINDS, renderNotification, type NotificationKind } from '@sre/notifications';
import { Hono } from 'hono';
import { requireUser, type AuthDeps, type AuthVariables } from './auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function encodeCursor(cursor: NotificationCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
}

function decodeCursor(value: string | undefined): NotificationCursor | null | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      parsed.createdAt.length > 64 ||
      !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== 'string' ||
      !UUID.test(parsed.id)
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

function knownKind(kind: string): kind is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(kind);
}

/** Builds authenticated, recipient-scoped inbox read and mutation routes. */
export function notificationRoutes(deps: {
  auth: AuthDeps;
  db: Db;
  appUrl: string;
}): Hono<{ Variables: AuthVariables }> {
  const routes = new Hono<{ Variables: AuthVariables }>();
  const identify = requireUser(deps.auth);
  routes.use('/me/notifications', identify);
  routes.use('/me/notifications/*', identify);

  routes.get('/me/notifications', async (c) => {
    const after = decodeCursor(c.req.query('after'));
    if (after === null) return c.json({ error: 'invalid notification cursor' }, 400);
    const page = await listUserNotifications(deps.db, {
      userId: c.get('user').userId,
      limit: 50,
      ...(after ? { after } : {}),
    });
    return c.json({
      notifications: page.notifications.map((row) => {
        const rendered = knownKind(row.kind)
          ? renderNotification(row.kind, row.payload, {
              app: deps.appUrl,
              emailAvailable: Boolean(row.emailedAt),
            })
          : {
              title: 'Account update',
              text: 'An account event was recorded in SRE Platform.',
              href: new URL('/w/notifications', deps.appUrl).href,
            };
        return {
          id: row.id,
          kind: row.kind,
          payload: row.payload,
          createdAt: row.createdAt,
          readAt: row.readAt,
          ...rendered,
        };
      }),
      unreadCount: page.unreadCount,
      nextCursor: encodeCursor(page.nextCursor),
    });
  });

  routes.post('/me/notifications/read-all', async (c) =>
    c.json({ marked: await markAllNotificationsRead(deps.db, c.get('user').userId) }),
  );

  routes.post('/me/notifications/:id/read', async (c) => {
    const id = c.req.param('id');
    if (!UUID.test(id)) return c.json({ error: 'notification not found' }, 404);
    const marked = await markNotificationRead(deps.db, c.get('user').userId, id);
    return marked ? c.json({ read: true }) : c.json({ error: 'notification not found' }, 404);
  });

  return routes;
}
