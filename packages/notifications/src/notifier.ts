import {
  createNotification,
  markNotificationEmailFailed,
  markNotificationEmailed,
  type Db,
} from '@sre/db';
import { renderEmail, type NotificationKind } from './templates';

export interface Recipient {
  userId?: string;
  email?: string;
}

export interface EmailAdapter {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

export interface Notifier {
  notify(
    recipient: Recipient,
    kind: NotificationKind,
    payload: Record<string, unknown>,
    context?: { tenantId?: string; eventKey?: string },
  ): Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates a durable-inbox-first notifier with optional best-effort email delivery.
 *
 * @param deps - Persistence, adapter resolver, public app URL, and structured error sink.
 */
export function makeNotifier(deps: {
  db: Db;
  email: () => Promise<EmailAdapter | null>;
  appUrl: string;
  log: { error(message: string, fields?: Record<string, unknown>): void };
}): Notifier {
  return {
    async notify(recipient, kind, payload, context = {}) {
      const result = await createNotification(deps.db, {
        recipientUserId: recipient.userId,
        recipientEmail: recipient.email,
        tenantId: context.tenantId,
        kind,
        payload,
        eventKey: context.eventKey,
      });
      if (!result.created || !result.recipientEmail) return;

      try {
        const adapter = await deps.email();
        if (!adapter) return;
        await adapter.send({
          to: result.recipientEmail,
          ...renderEmail(kind, payload, { app: deps.appUrl, emailAvailable: true }),
        });
        await markNotificationEmailed(deps.db, result.notification.id);
      } catch (error) {
        const message = errorMessage(error);
        try {
          await markNotificationEmailFailed(deps.db, result.notification.id, message);
        } catch (recordError) {
          deps.log.error('notification email outcome could not be recorded', {
            notificationId: result.notification.id,
            errorType: recordError instanceof Error ? recordError.name : typeof recordError,
          });
        }
        deps.log.error('notification email delivery failed', {
          notificationId: result.notification.id,
          errorType: error instanceof Error ? error.name : typeof error,
        });
      }
    },
  };
}
