import type { Db, PlatformSecretStore } from '@sre/db';
import { fetchPinnedHttps } from '@sre/connectors';
import type { PlatformSettings } from '@sre/platform-settings';
import type { AuthDeps } from './auth';
import { makeProviderVerifiers, type LocalVerifier } from './auth/providers';
import { makeOidcRuntime } from './onboarding/oidc-runtime';
import { mailboxEmailAdapter } from './notification-runtime';
import { makeBrowserSessionRuntime } from './onboarding/browser-session-runtime';

/** Connects browser sessions to the shared identity policy and configured email delivery.
 * @param input - Production stores, settings and explicit dashboard origin.
 */
export function makeIdentityRuntime(input: {
  appDb: Db;
  adminDb: Db;
  revoke: AuthDeps['revoke'];
  local?: LocalVerifier;
  secrets: PlatformSecretStore;
  settings: PlatformSettings;
  dashboardUrl: string;
  production: boolean;
}) {
  const verifiers = makeProviderVerifiers(input.appDb, {
    local: input.local,
    remoteFetch: (url, init) =>
      fetchPinnedHttps(url, {
        method: init?.method,
        headers: init?.headers,
        timeoutMs: 5_000,
        maxResponseBytes: 64 * 1024,
      }),
  });
  const auth: AuthDeps = {
    verifiers,
    db: input.appDb,
    adminDb: input.adminDb,
    settings: input.settings,
    revoke: input.revoke,
    allowLocalPlatformAdmin: Boolean(input.local),
  };
  const runtime = makeBrowserSessionRuntime({
    db: input.adminDb,
    auth,
    secrets: input.secrets,
    dashboardUrl: input.dashboardUrl,
    production: input.production,
    setting: (key) => input.settings.get(key),
    email: mailboxEmailAdapter(input),
  });
  auth.browserSession = runtime.resolve;
  return { auth, oidc: makeOidcRuntime(), browserSessions: runtime };
}
