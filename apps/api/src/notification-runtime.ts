import type { Db, PlatformSecretStore } from '@sre/db';
import { makeNotifier, makeSmtpAdapter } from '@sre/notifications';
import type { PlatformSettings } from '@sre/platform-settings';
import type { Logger } from './logger';

/** Resolves mandatory SMTP delivery without recording proofs in the product inbox.
 * @param deps - Current SMTP settings and encrypted password store.
 */
export function mailboxEmailAdapter(deps: {
  settings: PlatformSettings;
  secrets: PlatformSecretStore;
}) {
  return async () => {
    const current = await deps.settings.smtp();
    if (!current.config) return null;
    const password = current.config.username ? await deps.secrets.get('smtp.password') : null;
    return makeSmtpAdapter(current.config, password);
  };
}

/** Composes the process-wide notifier from durable settings and encrypted credentials. */
export function makeNotificationRuntime(deps: {
  db: Db;
  settings: PlatformSettings;
  secrets: PlatformSecretStore;
  appUrl: string;
  log: Logger;
}) {
  return makeNotifier({
    db: deps.db,
    appUrl: deps.appUrl,
    log: deps.log,
    email: async () => {
      const current = await deps.settings.smtp();
      if (!current.config) return null;
      const password = current.config.username ? await deps.secrets.get('smtp.password') : null;
      return makeSmtpAdapter(current.config, password);
    },
  });
}
