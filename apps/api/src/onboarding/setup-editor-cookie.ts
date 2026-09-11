import { getCookie, setCookie } from 'hono/cookie';
import type { Context } from 'hono';
import { browserCredentialHash, newBrowserCredential, type PlatformSecretStore } from '@sre/db';

/** Binds draft editing to its creating browser, independently of the directory being configured.
 * @param secrets - Encrypted storage for hashed edit credentials.
 * @param trusted - Exact-origin and custom-header check shared with browser sessions.
 * @param secure - Whether cookies require HTTPS.
 */
export function setupEditorCookie(
  secrets: PlatformSecretStore,
  trusted: (c: Context) => boolean,
  secure: boolean,
) {
  const name = `${secure ? '__Host-' : ''}sre-setup-editor`;
  return {
    async grant(c: Context, id: string) {
      if (!trusted(c)) return;
      const credential = getCookie(c, name) ?? newBrowserCredential();
      await secrets.put(`setup-editor:${id}`, browserCredentialHash(credential));
      setCookie(c, name, credential, {
        httpOnly: true,
        secure,
        sameSite: 'Lax',
        path: '/',
        maxAge: 3600,
      });
    },
    async allows(c: Context, id: string, allowMissingOrigin = false) {
      const trustedSafeRead =
        allowMissingOrigin &&
        c.req.method === 'GET' &&
        !c.req.header('origin') &&
        c.req.header('x-sre-session') === '1';
      if (!trusted(c) && !trustedSafeRead) return false;
      const credential = getCookie(c, name);
      return Boolean(
        credential &&
        (await secrets.get(`setup-editor:${id}`)) === browserCredentialHash(credential),
      );
    },
  };
}
