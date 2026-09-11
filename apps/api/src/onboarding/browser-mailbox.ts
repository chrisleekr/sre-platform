import { randomInt } from 'node:crypto';
import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { getMailboxProof, resendMailboxProof, type Db } from '@sre/db';
import type { EmailAdapter } from '@sre/notifications';
import { OidcCompletionError } from './oidc-relay';

/** Sends proof directly through SMTP, never through the product notification inbox.
 * @param adapter - Configured SMTP sender.
 * @param email - OIDC-bound candidate mailbox.
 * @param code - One-time code.
 */
export async function sendMailboxCode(adapter: EmailAdapter, email: string, code: string) {
  await adapter.send({
    to: email,
    subject: 'Verify your SRE Platform sign-in',
    text: `Your verification code is ${code}. It expires in 10 minutes. If you did not request this sign-in, ignore this message.`,
  });
}

/** Keeps recipient context and resend tied to the same HttpOnly pending sign-in.
 * @param deps - Proof store, SMTP resolver and shared browser-cookie policy.
 */
export function browserMailbox(deps: {
  db: Db;
  email(): Promise<EmailAdapter | null>;
  cookie: string;
  cookieOptions: { httpOnly: boolean; secure: boolean; sameSite: 'Lax'; path: string };
}) {
  return {
    async status(c: Context) {
      const credential = getCookie(c, deps.cookie);
      const proof = credential ? await getMailboxProof(deps.db, credential) : null;
      if (!proof)
        throw new OidcCompletionError(
          'mailbox_expired',
          'This email check expired. Restart the same sign-in to receive another code.',
        );
      const [name, domain] = proof.identity.email.split('@');
      return {
        recipient: `${name!.slice(0, 1)}***@${domain}`,
        expiresAt: proof.expiresAt.getTime(),
        resendAt: proof.lastSentAt.getTime() + 60_000,
      };
    },
    async resend(c: Context) {
      const credential = getCookie(c, deps.cookie);
      const adapter = await deps.email();
      if (!adapter)
        throw new OidcCompletionError(
          'mailbox_delivery_unavailable',
          'Ask your administrator to configure email delivery, then restart sign-in.',
        );
      const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
      const proof = credential ? await resendMailboxProof(deps.db, credential, code) : null;
      if (!proof)
        throw new OidcCompletionError(
          'mailbox_resend_unavailable',
          'Wait one minute between emails. If the code expired, restart the same sign-in.',
        );
      await sendMailboxCode(adapter, proof.identity.email, code);
      setCookie(c, deps.cookie, credential!, {
        ...deps.cookieOptions,
        maxAge: Math.max(0, Math.floor((proof.expiresAt.getTime() - Date.now()) / 1_000)),
      });
      return {
        resendAt: proof.lastSentAt.getTime() + 60_000,
        expiresAt: proof.expiresAt.getTime(),
      };
    },
  };
}
