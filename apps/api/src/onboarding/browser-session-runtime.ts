import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import {
  browserCredentialHash,
  newBrowserCredential,
  createOidcAttempt,
  consumeOidcAttempt,
  createBrowserSession,
  getBrowserSession,
  getWorkspaceMembershipAccess,
  selectBrowserSessionWorkspace,
  revokeBrowserSession,
  createMailboxProof,
  consumeMailboxProof,
  completeOidcFoundingOnce,
  findOidcFoundingOwnerRecovery,
  retireDuplicateOidcFounding,
  FoundingStateError,
  identityProviders,
  upsertUserForSignIn,
  workspaceFoundings,
  isOnboardingFoundingOwner,
  type Db,
  type PlatformSecretStore,
  type PendingMailboxIdentity,
} from '@sre/db';
import type { EmailAdapter } from '@sre/notifications';
import type { AuthDeps, IdentityResolution } from '../auth';
import { resolveIdentityAccess } from '../auth/identity-access';
import { makeBrowserOidc } from './browser-oidc';
import { OidcCompletionError } from './oidc-relay';
import { browserMailbox, sendMailboxCode } from './browser-mailbox';
import { setupEditorCookie } from './setup-editor-cookie';

export interface BrowserSessionDependencies {
  db: Db;
  auth: AuthDeps;
  secrets: PlatformSecretStore;
  dashboardUrl: string;
  production: boolean;
  setting(key: 'SESSION_IDLE_SECONDS' | 'SESSION_ABSOLUTE_SECONDS'): Promise<number>;
  email(): Promise<EmailAdapter | null>;
  exchange?: ReturnType<typeof makeBrowserOidc>;
}

/** Owns browser credentials, callback attempts and conditional mailbox proof.
 * @param deps - Authoritative identity stores and explicit deployment origins.
 */
export function makeBrowserSessionRuntime(deps: BrowserSessionDependencies) {
  const origin = new URL(deps.dashboardUrl).origin;
  if (deps.production && !origin.startsWith('https://'))
    throw new Error('Production browser sessions require an HTTPS dashboard URL.');
  const prefix = deps.production ? '__Host-' : '';
  const sessionCookie = `${prefix}sre-session`;
  const attemptCookie = `${prefix}sre-oidc-browser`;
  const proofCookie = `${prefix}sre-mailbox-proof`;
  const exchange = deps.exchange ?? makeBrowserOidc(deps.secrets);
  const cookieOptions = {
    httpOnly: true,
    secure: deps.production,
    sameSite: 'Lax' as const,
    path: '/',
  };
  const denied = (): IdentityResolution => ({
    ok: false,
    status: 401,
    error: 'Sign in to continue.',
  });

  function isTrustedRequest(c: Context): boolean {
    return c.req.header('origin') === origin && c.req.header('x-sre-session') === '1';
  }

  async function provider(id: string) {
    const [row] = await deps.db
      .select()
      .from(identityProviders)
      .where(eq(identityProviders.id, id))
      .limit(1);
    if (!row || row.kind !== 'oidc' || !row.browserClientId || !row.authorizationEndpoint) {
      throw new OidcCompletionError(
        'provider_unavailable',
        'This sign-in method is unavailable. Ask its administrator to check the connection.',
      );
    }
    return row;
  }

  async function foundingFor(id: string, providerId: string) {
    const [row] = await deps.db
      .select()
      .from(workspaceFoundings)
      .where(and(eq(workspaceFoundings.id, id), eq(workspaceFoundings.providerId, providerId)))
      .limit(1);
    if (
      !row ||
      row.status === 'expired' ||
      (row.status !== 'active' && row.expiresAt && row.expiresAt.getTime() <= Date.now())
    ) {
      throw new OidcCompletionError(
        'setup_expired',
        'This setup request has expired. Start a new workspace setup.',
      );
    }
    return row;
  }

  async function finish(c: Context, identity: PendingMailboxIdentity) {
    let selected = await provider(identity.providerId);
    let recoveredOwner = false;
    let recoveredDuplicate: { foundingId: string; providerId: string } | null = null;
    if (
      selected.issuer !== identity.issuer ||
      selected.browserClientId !== identity.clientId ||
      !['active', 'provisional', 'pending_verification'].includes(selected.status)
    ) {
      throw new OidcCompletionError(
        'provider_changed',
        'The sign-in application changed. Start a fresh sign-in.',
      );
    }
    const authenticatedAt = new Date(identity.authenticatedAt);
    let foundingId = identity.foundingId;
    if (foundingId) {
      let founding = await foundingFor(foundingId, selected.id);
      if (identity.email.split('@')[1] !== founding.declaredDomain?.toLowerCase()) {
        throw new OidcCompletionError(
          'work_email_mismatch',
          'Sign in with an email belonging to the work domain you entered.',
        );
      }
      if (founding.status === 'awaiting_founder') {
        const recovery = await findOidcFoundingOwnerRecovery(deps.db, {
          issuer: selected.issuer,
          browserClientId: selected.browserClientId!,
          subjectClaim: selected.subjectClaim,
          subject: identity.subject,
          duplicateFoundingId: founding.id,
        });
        if (recovery) {
          recoveredDuplicate = { foundingId: founding.id, providerId: selected.id };
          recoveredOwner = true;
          foundingId = recovery.foundingId;
          selected = await provider(recovery.providerId);
          founding = await foundingFor(foundingId, selected.id);
        } else {
          try {
            await completeOidcFoundingOnce(deps.db, founding.id, selected.id, async () => ({
              identity: {
                issuer: identity.issuer,
                subject: identity.subject,
                email: identity.email,
              },
              result: null,
            }));
          } catch (error) {
            if (
              error instanceof FoundingStateError &&
              error.code === 'directory_already_connected'
            ) {
              throw new OidcCompletionError(
                error.code,
                'This sign-in application already belongs to a workspace. Sign in with its founder account or connect a different application.',
              );
            }
            throw error;
          }
        }
      }
      if (
        founding.status !== 'awaiting_founder' &&
        !recoveredOwner &&
        !(await isOnboardingFoundingOwner(deps.db, {
          foundingId,
          providerId: selected.id,
          issuer: identity.issuer,
          subject: identity.subject,
        }))
      ) {
        throw new OidcCompletionError(
          'setup_owner_mismatch',
          'Use the same account that started this workspace.',
        );
      }
      if (selected.status === 'active') foundingId = null;
    } else if (selected.status !== 'active') {
      throw new OidcCompletionError(
        'provider_unavailable',
        'This sign-in method is not active. Resume its workspace setup first.',
      );
    }
    const signedIn = await upsertUserForSignIn(deps.db, {
      providerId: selected.id,
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      emailVerified: true,
    });
    if (signedIn.status === 'directory_unverified') {
      throw new OidcCompletionError(
        'directory_unverified',
        'This account is not active in the workspace directory. Contact your administrator.',
      );
    }
    if (
      signedIn.status !== 'active' ||
      (signedIn.notBefore && authenticatedAt < signedIn.notBefore)
    ) {
      throw new OidcCompletionError(
        'account_unavailable',
        'This account was disabled or signed out. Start a fresh sign-in or contact your administrator.',
      );
    }
    const idleSeconds = await deps.setting('SESSION_IDLE_SECONDS');
    const absoluteSeconds = await deps.setting('SESSION_ABSOLUTE_SECONDS');
    if (authenticatedAt.getTime() + absoluteSeconds * 1_000 <= Date.now()) {
      throw new OidcCompletionError(
        'authentication_expired',
        'Your directory sign-in is too old. Sign in again.',
      );
    }
    const created = await createBrowserSession(deps.db, {
      providerId: selected.id,
      clientId: identity.clientId,
      userId: signedIn.userId,
      foundingId,
      oidcSubject: identity.oidcSubject,
      oidcSessionId: identity.oidcSessionId,
      bindingClaimValue: identity.bindingClaimValue,
      authenticatedAt,
      idleSeconds,
      absoluteSeconds,
    });
    if (recoveredDuplicate) {
      try {
        const retired = await retireDuplicateOidcFounding(deps.db, recoveredDuplicate);
        if (!retired) throw new Error('duplicate setup changed during sign-in');
      } catch {
        await revokeBrowserSession(deps.db, created.credential).catch(() => undefined);
        throw new OidcCompletionError(
          'setup_recovery_failed',
          'We verified your workspace, but could not finish cleaning up the duplicate setup. Try signing in again.',
        );
      }
    }
    const previous = getCookie(c, sessionCookie);
    if (previous) await revokeBrowserSession(deps.db, previous);
    setCookie(c, sessionCookie, created.credential, {
      ...cookieOptions,
      expires: created.session.absoluteExpiresAt,
    });
    deleteCookie(c, proofCookie, cookieOptions);
    return {
      returnTo: identity.returnTo,
      foundingId,
      expiresAt: created.session.absoluteExpiresAt.getTime(),
    };
  }

  return {
    isTrustedRequest,
    setupEditor: setupEditorCookie(deps.secrets, isTrustedRequest, deps.production),
    mailbox: browserMailbox({ db: deps.db, email: deps.email, cookie: proofCookie, cookieOptions }),
    async start(c: Context, input: { providerId: string; foundingId?: string; returnTo?: string }) {
      const selected = await provider(input.providerId);
      if (input.foundingId) await foundingFor(input.foundingId, selected.id);
      else if (selected.status !== 'active')
        throw new OidcCompletionError(
          'provider_unavailable',
          'Resume workspace setup before using this sign-in method.',
        );
      const browser = getCookie(c, attemptCookie) ?? newBrowserCredential();
      const nonce = newBrowserCredential();
      const codeVerifier = newBrowserCredential();
      const redirectUri = `${origin}/auth/callback`;
      const returnTo =
        input.returnTo?.startsWith('/') &&
        !input.returnTo.startsWith('//') &&
        !input.returnTo.includes('\\')
          ? input.returnTo
          : input.foundingId
            ? '/get-started'
            : '/w';
      const state = await createOidcAttempt(deps.db, {
        browserHash: browserCredentialHash(browser),
        providerId: selected.id,
        foundingId: input.foundingId ?? null,
        nonce,
        codeVerifier,
        redirectUri,
        returnTo,
        expiresAt: new Date(Date.now() + 600_000),
      });
      setCookie(c, attemptCookie, browser, { ...cookieOptions, maxAge: 600 });
      const url = new URL(selected.authorizationEndpoint!);
      url.search = new URLSearchParams({
        response_type: 'code',
        scope: 'openid email profile',
        client_id: selected.browserClientId!,
        redirect_uri: redirectUri,
        state,
        nonce,
        code_challenge: Buffer.from(browserCredentialHash(codeVerifier), 'hex').toString(
          'base64url',
        ),
        code_challenge_method: 'S256',
      }).toString();
      return { authorizationUrl: url.toString() };
    },
    async complete(c: Context, input: { state: string; code: string }) {
      const browser = getCookie(c, attemptCookie);
      const attempt = browser ? await consumeOidcAttempt(deps.db, input.state, browser) : null;
      if (!attempt)
        throw new OidcCompletionError(
          'invalid_attempt',
          'This sign-in link expired or was already used. Return to sign-in and try again.',
        );
      const selected = await provider(attempt.providerId);
      if (attempt.foundingId) await foundingFor(attempt.foundingId, selected.id);
      else if (selected.status !== 'active')
        throw new OidcCompletionError('provider_unavailable', 'This sign-in method was disabled.');
      const verified = await exchange(selected, attempt, input.code);
      const identity: PendingMailboxIdentity = {
        ...verified,
        authenticatedAt: verified.authenticatedAt.toISOString(),
        providerId: selected.id,
        clientId: selected.browserClientId!,
        foundingId: attempt.foundingId,
        returnTo: attempt.returnTo,
      };
      if (!verified.emailVerified) {
        if (attempt.foundingId) {
          const founding = await foundingFor(attempt.foundingId, selected.id);
          if (identity.email.split('@')[1] !== founding.declaredDomain?.toLowerCase()) {
            throw new OidcCompletionError(
              'work_email_mismatch',
              'Use an account from the work domain you entered.',
            );
          }
        }
        const mail = await deps.email();
        if (!mail)
          throw new OidcCompletionError(
            'mailbox_delivery_unavailable',
            'This directory requires email verification. Ask your platform administrator to configure email delivery, then try again.',
          );
        const code = randomInt(0, 100_000_000).toString().padStart(8, '0');
        const proof = await createMailboxProof(deps.db, identity, code);
        await sendMailboxCode(mail, identity.email, code);
        setCookie(c, proofCookie, proof, { ...cookieOptions, maxAge: 600 });
        return { returnTo: '/auth/verify-email', mailboxVerificationRequired: true };
      }
      return finish(c, identity);
    },
    async verifyMailbox(c: Context, code: string) {
      const credential = getCookie(c, proofCookie);
      const identity = credential ? await consumeMailboxProof(deps.db, credential, code) : null;
      if (!identity)
        throw new OidcCompletionError(
          'invalid_mailbox_code',
          'The code is incorrect, expired, or already used. Try again or restart sign-in.',
        );
      return finish(c, identity);
    },
    async resolve(c: Context, foundingId?: string): Promise<IdentityResolution> {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !isTrustedRequest(c)) {
        return { ok: false, status: 403, error: 'Request origin could not be verified.' };
      }
      const credential = getCookie(c, sessionCookie);
      const row = credential
        ? await getBrowserSession(deps.db, credential, await deps.setting('SESSION_IDLE_SECONDS'))
        : null;
      if (!row) return denied();
      if (c.req.header('x-sre-session-id') && c.req.header('x-sre-session-id') !== row.session.id)
        return denied();
      if (
        foundingId &&
        row.provider.status !== 'active' &&
        !(await isOnboardingFoundingOwner(deps.db, {
          foundingId,
          providerId: row.provider.id,
          issuer: row.user.issuer,
          subject: row.user.subject,
        }))
      )
        return denied();
      return resolveIdentityAccess(deps.auth, {
        providerId: row.provider.id,
        issuer: row.user.issuer,
        subject: row.user.subject,
        email: row.user.email ?? undefined,
        issuedAt: row.session.authenticatedAt.getTime() / 1_000,
        expiresAt:
          Math.min(
            row.session.absoluteExpiresAt.getTime(),
            Date.now() + (await deps.setting('SESSION_IDLE_SECONDS')) * 1_000,
          ) / 1_000,
        scope: row.provider.scope,
        bindingClaimValue: row.session.bindingClaimValue,
        applicationSessionId: row.session.id,
        selectedTenantId: row.session.selectedTenantId,
        scopes: [],
      });
    },
    async selectWorkspace(c: Context, tenantId: string) {
      if (!isTrustedRequest(c)) return { ok: false as const, status: 403 as const };
      const credential = getCookie(c, sessionCookie);
      const row = credential
        ? await getBrowserSession(deps.db, credential, await deps.setting('SESSION_IDLE_SECONDS'))
        : null;
      if (!row) return { ok: false as const, status: 401 as const };
      if (c.req.header('x-sre-session-id') && c.req.header('x-sre-session-id') !== row.session.id)
        return { ok: false as const, status: 401 as const };
      const access = await getWorkspaceMembershipAccess(deps.db, {
        userId: row.user.id,
        providerId: row.provider.id,
        tenantId,
        claimValue: row.session.bindingClaimValue,
      });
      if (access.status !== 'ok') return { ok: false as const, status: 403 as const };
      const selected = await selectBrowserSessionWorkspace(deps.db, row.session.id, tenantId);
      if (!selected) return { ok: false as const, status: 401 as const };
      setCookie(c, sessionCookie, selected.credential, {
        ...cookieOptions,
        expires: selected.session.absoluteExpiresAt,
      });
      await deps.auth.revoke.publish({ userId: row.user.id, applicationSessionId: row.session.id });
      return { ok: true as const };
    },
    async status(c: Context) {
      const credential = getCookie(c, sessionCookie);
      const row = credential
        ? await getBrowserSession(deps.db, credential, await deps.setting('SESSION_IDLE_SECONDS'))
        : null;
      return row
        ? {
            authenticated: true,
            expiresAt: row.session.absoluteExpiresAt.getTime(),
            providerId: row.provider.id,
            sessionId: row.session.id,
            foundingId: row.provider.status === 'active' ? null : row.session.foundingId,
            user: { id: row.user.id, email: row.user.email },
          }
        : { authenticated: false };
    },
    async logout(c: Context) {
      const credential = getCookie(c, sessionCookie);
      const session = credential ? await revokeBrowserSession(deps.db, credential) : null;
      deleteCookie(c, sessionCookie, cookieOptions);
      if (session)
        await deps.auth.revoke.publish({
          userId: session.userId,
          applicationSessionId: session.id,
        });
    },
  };
}
