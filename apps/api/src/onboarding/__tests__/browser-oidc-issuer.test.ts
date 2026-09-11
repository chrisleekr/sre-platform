import { beforeAll, expect, test, vi } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT, type JWK } from 'jose';
import type { IdentityProviderRow, PlatformSecretStore } from '@sre/db';
import { makeBrowserOidc } from '../browser-oidc';

let key: CryptoKey;
let jwk: JWK;
beforeAll(async () => {
  const pair = await generateKeyPair('RS256', { extractable: true });
  key = pair.privateKey;
  jwk = await exportJWK(pair.publicKey);
});

test.each([
  ['https://accounts.google.com', 'https://accounts.google.com', true],
  ['https://accounts.google.com', 'accounts.google.com', true],
  ['https://other.example.test', 'accounts.google.com', false],
  ['https://other.example.test', 'other.example.test', false],
  ['https://accounts.google.com', 'https://accounts.google.com.attacker.test', false],
  ['https://accounts.google.com', 'accounts.google.com', false, 'different-client'],
])(
  'configured issuer %s accepts token issuer %s only when documented (%s)',
  async (issuer, tokenIssuer, accepted, audience = 'registered-client') => {
    const provider: IdentityProviderRow = {
      id: 'issuer-test',
      displayName: 'Directory',
      issuer,
      jwksUri: `${issuer}/jwks`,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      audience: null,
      kind: 'oidc',
      scope: 'tenant',
      supportsSignup: false,
      emailClaim: 'email',
      tenantClaim: null,
      subjectClaim: 'sub',
      browserClientId: 'registered-client',
      backchannelLogout: false,
      backchannelLogoutTypRequired: false,
      scimEnabled: false,
      scimTokenHash: null,
      scimTokenCreatedAt: null,
      scimTokenExpiresAt: null,
      requireProvisioned: false,
      scimIdentityAttribute: 'externalId',
      clientAuthentication: 'none',
      authorizationScopes: [],
      authorizationAudience: null,
      sortOrder: 0,
      status: 'active',
      expiresAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const secrets: PlatformSecretStore = {
      put: vi.fn(),
      get: vi.fn(),
      has: vi.fn(),
      delete: vi.fn(),
    };
    const exchange = makeBrowserOidc(secrets, {
      fetchJson: async () => ({ keys: [{ ...jwk, kid: 'key', alg: 'RS256' }] }),
      postForm: async () => ({
        id_token: await new SignJWT({
          nonce: 'nonce',
          email: 'owner@company.test',
          email_verified: true,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'key' })
          .setIssuer(tokenIssuer)
          .setAudience(audience)
          .setSubject('stable-subject')
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(key),
      }),
    });
    const result = exchange(
      provider,
      {
        codeVerifier: 'verifier',
        redirectUri: 'https://app.example.test/auth/callback',
        nonce: 'nonce',
      },
      'code',
    );
    if (accepted)
      await expect(result).resolves.toMatchObject({ issuer, subject: 'stable-subject' });
    else await expect(result).rejects.toThrow();
    expect(secrets.get).not.toHaveBeenCalled();
  },
);
