import { and, desc, eq, getTableColumns, isNull, sql } from 'drizzle-orm';
import type { Db } from './client';
import { notifications, users } from './schema';

export interface NotificationCursor {
  /** Exact Postgres timestamp text, preserving precision that JavaScript Date would discard. */
  createdAt: string;
  id: string;
}

export interface CreateNotificationInput {
  recipientUserId?: string;
  recipientEmail?: string;
  tenantId?: string;
  kind: string;
  payload: Record<string, unknown>;
  eventKey?: string;
}

function normalizedEmail(value: string | undefined): string | null {
  const email = value?.trim().toLowerCase();
  return email || null;
}

async function recipientEmail(
  db: Db,
  row: typeof notifications.$inferSelect,
): Promise<string | null> {
  if (row.recipientEmail) return row.recipientEmail;
  if (!row.recipientUserId) return null;
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, row.recipientUserId))
    .limit(1);
  return normalizedEmail(user?.email ?? undefined);
}

/**
 * Inserts one durable notification or returns the row already written for the same event.
 *
 * @param db - Database connection used for the recipient-scoped record.
 * @param input - Recipient, event identity, kind, and display payload.
 */
export async function createNotification(db: Db, input: CreateNotificationInput) {
  const email = normalizedEmail(input.recipientEmail);
  if (!input.recipientUserId && !email) throw new TypeError('notification recipient is required');
  const eventKey = input.eventKey?.trim() || null;
  const [inserted] = await db
    .insert(notifications)
    .values({
      recipientUserId: input.recipientUserId ?? null,
      recipientEmail: email,
      tenantId: input.tenantId ?? null,
      kind: input.kind,
      payload: input.payload,
      eventKey,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) {
    return {
      notification: inserted,
      created: true,
      recipientEmail: await recipientEmail(db, inserted),
    };
  }
  if (!eventKey) throw new Error('notification insert returned no row');
  const [existing] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.eventKey, eventKey))
    .limit(1);
  if (!existing) throw new Error('notification event conflict returned no row');
  return {
    notification: existing,
    created: false,
    recipientEmail: await recipientEmail(db, existing),
  };
}

/**
 * Lists one recipient's newest notifications and exact total unread count.
 *
 * @param db - App-role database connection.
 * @param input - Authenticated user, page bound, and optional exclusive cursor.
 */
export async function listUserNotifications(
  db: Db,
  input: { userId: string; limit: number; after?: NotificationCursor },
) {
  const cursor = input.after
    ? sql`(${notifications.createdAt}, ${notifications.id}) < (${input.after.createdAt}::timestamptz, ${input.after.id}::uuid)`
    : undefined;
  const rows = await db
    .select({
      ...getTableColumns(notifications),
      cursorCreatedAt: sql<string>`${notifications.createdAt}::text`,
    })
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, input.userId), cursor))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(input.limit + 1);
  const [unread] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(eq(notifications.recipientUserId, input.userId), isNull(notifications.readAt)));
  const hasMore = rows.length > input.limit;
  const pageRows = rows.slice(0, input.limit);
  const tail = hasMore ? pageRows.at(-1) : undefined;
  return {
    notifications: pageRows.map(({ cursorCreatedAt: _cursorCreatedAt, ...row }) => row),
    unreadCount: unread?.count ?? 0,
    nextCursor: tail ? { createdAt: tail.cursorCreatedAt, id: tail.id } : null,
  };
}

/**
 * Marks one notification read only when it belongs to the authenticated recipient.
 *
 * @param db - App-role database connection.
 * @param userId - Authenticated recipient.
 * @param notificationId - Notification selected by the recipient.
 */
export async function markNotificationRead(
  db: Db,
  userId: string,
  notificationId: string,
): Promise<boolean> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`coalesce(${notifications.readAt}, clock_timestamp())` })
    .where(and(eq(notifications.id, notificationId), eq(notifications.recipientUserId, userId)))
    .returning({ id: notifications.id });
  return rows.length === 1;
}

/**
 * Marks every unread notification for one authenticated recipient read.
 *
 * @param db - App-role database connection.
 * @param userId - Authenticated recipient.
 */
export async function markAllNotificationsRead(db: Db, userId: string): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ readAt: sql`clock_timestamp()` })
    .where(and(eq(notifications.recipientUserId, userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}

/**
 * Records successful optional email delivery without changing inbox durability.
 *
 * @param db - Database connection used for the notification row.
 * @param notificationId - Notification whose email copy completed.
 */
export async function markNotificationEmailed(db: Db, notificationId: string): Promise<void> {
  await db
    .update(notifications)
    .set({ emailedAt: sql`clock_timestamp()`, emailError: null })
    .where(eq(notifications.id, notificationId));
}

/**
 * Records the optional email adapter's exact failure for operator diagnosis.
 *
 * @param db - Database connection used for the notification row.
 * @param notificationId - Notification whose email copy failed.
 * @param message - Exact adapter error retained for operator diagnosis.
 */
export async function markNotificationEmailFailed(
  db: Db,
  notificationId: string,
  message: string,
): Promise<void> {
  await db
    .update(notifications)
    .set({ emailedAt: null, emailError: message })
    .where(eq(notifications.id, notificationId));
}
