import type { SmtpSettings } from '@sre/platform-settings';
import nodemailer from 'nodemailer';
import type { EmailAdapter } from './notifier';

/**
 * Creates one SMTP adapter from validated settings and an optional encrypted password.
 *
 * @param settings - Validated SMTP endpoint, sender, and optional username.
 * @param password - Decrypted password for authenticated SMTP.
 */
export function makeSmtpAdapter(settings: SmtpSettings, password: string | null): EmailAdapter {
  if (settings.username && !password) throw new Error('SMTP password is not configured');
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    auth: settings.username ? { user: settings.username, pass: password! } : undefined,
    disableFileAccess: true,
    disableUrlAccess: true,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
  return {
    async send(message) {
      await transport.sendMail({ from: settings.from, ...message });
    },
  };
}
