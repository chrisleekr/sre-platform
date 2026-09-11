import { describe, expect, test, vi } from 'vitest';
import { discoverOidcProvider } from '../oidc-discovery';

const ISSUER = 'https://directory.example/tenant';
const METADATA = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/jwks`,
};

describe('OIDC provider discovery', () => {
  test('loads the exact well-known document and returns only validated browser/server endpoints', async () => {
    const fetchJson = vi.fn(async () => METADATA);

    await expect(discoverOidcProvider(ISSUER, { fetchJson })).resolves.toEqual({
      issuer: ISSUER,
      authorizationEndpoint: `${ISSUER}/authorize`,
      tokenEndpoint: `${ISSUER}/token`,
      jwksUri: `${ISSUER}/jwks`,
    });
    expect(fetchJson).toHaveBeenCalledWith(
      new URL(`${ISSUER}/.well-known/openid-configuration`),
      expect.objectContaining({ maxResponseBytes: 64 * 1024, redirect: 'error', timeoutMs: 5_000 }),
    );
  });

  test.each([
    ['issuer mismatch', { ...METADATA, issuer: 'https://other.example' }],
    [
      'insecure authorization endpoint',
      { ...METADATA, authorization_endpoint: 'http://idp/authorize' },
    ],
    ['insecure token endpoint', { ...METADATA, token_endpoint: 'http://idp/token' }],
    ['insecure JWKS endpoint', { ...METADATA, jwks_uri: 'http://idp/jwks' }],
    ['missing JWKS endpoint', { ...METADATA, jwks_uri: undefined }],
  ])('rejects %s without returning partial metadata', async (_label, document) => {
    await expect(
      discoverOidcProvider(ISSUER, { fetchJson: async () => document }),
    ).rejects.toThrow();
  });

  test('rejects issuer credentials, query strings, and fragments before network I/O', async () => {
    const fetchJson = vi.fn();
    for (const issuer of [
      'https://user:pass@directory.example',
      'https://directory.example?tenant=a',
      'https://directory.example#tenant',
    ]) {
      await expect(discoverOidcProvider(issuer, { fetchJson })).rejects.toThrow(/issuer/i);
    }
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
