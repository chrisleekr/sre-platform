import { jwtVerify, type JWTPayload } from 'jose';
import type { IdentityProviderRow, PlatformSecretStore } from '@sre/db';
import {
  loadProviderJwks,
  fetchGuardedJson,
  postGuardedForm,
  OidcCompletionError,
  type FormPoster,
} from './oidc-relay';
import type { JsonFetcher } from './oidc-discovery';

export interface BrowserOidcIdentity {
  issuer: string;
  subject: string;
  oidcSubject: string;
  email: string;
  emailVerified: boolean;
  oidcSessionId?: string;
  bindingClaimValue: string | null;
  authenticatedAt: Date;
}

function textClaim(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Exchanges and verifies standard OIDC without accepting an API access token as identity.
 * @param secrets - Write-only client credential storage.
 * @param transport - Bounded external HTTP operations; tests replace only the provider network.
 */
export function makeBrowserOidc(
  secrets: PlatformSecretStore,
  transport: {
    postForm?: FormPoster;
    fetchJson?: JsonFetcher;
  } = {},
) {
  return async (
    provider: IdentityProviderRow,
    attempt: {
      codeVerifier: string;
      redirectUri: string;
      nonce: string;
    },
    code: string,
  ): Promise<BrowserOidcIdentity> => {
    if (!provider.tokenEndpoint || !provider.browserClientId) {
      throw new OidcCompletionError('invalid_provider', 'The sign-in application is incomplete.');
    }
    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: provider.browserClientId,
      code,
      code_verifier: attempt.codeVerifier,
      redirect_uri: attempt.redirectUri,
    };
    const headers: Record<string, string> = {};
    if (provider.clientAuthentication !== 'none') {
      const secret = await secrets.get(`oidc-client:${provider.id}`);
      if (!secret)
        throw new OidcCompletionError(
          'missing_client_secret',
          'The sign-in application secret is not configured.',
        );
      if (provider.clientAuthentication === 'client_secret_basic') {
        // OAuth Basic encodes each credential as form data before joining with the separator.
        const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
        headers.authorization = `Basic ${Buffer.from(`${encode(provider.browserClientId)}:${encode(secret)}`).toString('base64')}`;
        delete form.client_id;
      } else {
        form.client_secret = secret;
      }
    }
    const tokenSet = (await (transport.postForm ?? postGuardedForm)(
      new URL(provider.tokenEndpoint),
      form,
      headers,
    )) as { id_token?: unknown } | null;
    if (typeof tokenSet?.id_token !== 'string') {
      throw new OidcCompletionError(
        'missing_id_token',
        'The directory did not return an identity token. Enable OpenID Connect for this application.',
      );
    }
    const keys = await loadProviderJwks(provider, {
      fetchJson: transport.fetchJson ?? fetchGuardedJson,
    });
    const { payload } = await jwtVerify(tokenSet.id_token, keys, {
      // Google documents both token issuers; identity storage still uses its discovered HTTPS issuer.
      issuer:
        provider.issuer === 'https://accounts.google.com'
          ? ['https://accounts.google.com', 'accounts.google.com']
          : provider.issuer,
      audience: provider.browserClientId,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
    });
    if (
      payload.nonce !== attempt.nonce ||
      (payload.azp !== undefined && payload.azp !== provider.browserClientId) ||
      (Array.isArray(payload.aud) &&
        payload.aud.length > 1 &&
        payload.azp !== provider.browserClientId) ||
      typeof payload.iat !== 'number' ||
      !Number.isFinite(payload.iat) ||
      payload.iat > Date.now() / 1_000 + 60 ||
      payload.iat >= payload.exp!
    ) {
      throw new OidcCompletionError(
        'invalid_identity_token',
        'The directory returned an identity token for a different sign-in attempt.',
      );
    }
    const oidcSubject = textClaim(payload, 'sub');
    const subject = textClaim(payload, provider.subjectClaim);
    const email = textClaim(payload, 'email')?.toLowerCase();
    if (!subject || !oidcSubject || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new OidcCompletionError(
        'missing_work_email',
        'The directory did not share a work email. Allow the email claim for this application and try again.',
      );
    }
    return {
      issuer: provider.issuer,
      subject,
      oidcSubject,
      email,
      emailVerified: payload.email_verified === true,
      oidcSessionId: textClaim(payload, 'sid'),
      bindingClaimValue:
        provider.scope === 'installation' && provider.tenantClaim
          ? (textClaim(payload, provider.tenantClaim) ?? null)
          : null,
      authenticatedAt: new Date(payload.iat * 1_000),
    };
  };
}
