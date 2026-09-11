import { describe, expect, test, vi } from 'vitest';
const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@sre/connectors', async () => ({
  ...(await vi.importActual('@sre/connectors')),
  fetchPinnedHttps: transport.fetch,
}));
import { fetchGuardedJson, loadProviderJwks, postGuardedForm } from '../oidc-relay';
describe('bounded OIDC transport', () => {
  test('loads JWKS only from the persisted URL through the guarded client', async () => {
    const fetchJson = vi.fn(async () => ({ keys: [] }));
    await expect(
      loadProviderJwks(
        { id: 'provider', jwksUri: 'https://directory.example/keys' },
        { fetchJson },
      ),
    ).resolves.toBeDefined();
    expect(fetchJson).toHaveBeenCalledWith(new URL('https://directory.example/keys'), {
      maxResponseBytes: 65536,
      redirect: 'error',
      timeoutMs: 5000,
    });
  });
  test('rejects malformed signing-key documents', async () => {
    await expect(
      loadProviderJwks(
        { id: 'provider', jwksUri: 'https://directory.example/keys' },
        { fetchJson: async () => ({}) },
      ),
    ).rejects.toThrow('JWKS document is invalid');
  });
  test('posts credentials only to the guarded persisted endpoint', async () => {
    transport.fetch.mockResolvedValue(Response.json({ id_token: 'token' }));
    await postGuardedForm(new URL('https://directory.example/token'), {
      client_id: 'client',
      client_secret: 'test-only',
    });
    expect(transport.fetch).toHaveBeenLastCalledWith(
      new URL('https://directory.example/token'),
      expect.objectContaining({ method: 'POST', timeoutMs: 5000, maxResponseBytes: 65536 }),
    );
  });
  test.each(['invalid_client', 'unrecognized_error'])(
    'sanitizes provider error %s without reflecting its payload',
    async (code) => {
      transport.fetch.mockResolvedValue(
        Response.json({ error: code, error_description: 'echoed-client-secret' }, { status: 400 }),
      );
      await expect(
        postGuardedForm(new URL('https://directory.example/token'), {}),
      ).rejects.not.toThrow('echoed-client-secret');
    },
  );
  test('forwards Basic credentials only in the protected header and sanitizes echoed encoded secrets', async () => {
    const authorization = `Basic ${Buffer.from('client:encoded-secret').toString('base64')}`;
    transport.fetch.mockResolvedValue(
      Response.json({ error: 'invalid_client', error_description: authorization }, { status: 400 }),
    );
    await expect(
      postGuardedForm(
        new URL('https://directory.example/token'),
        { grant_type: 'authorization_code' },
        { authorization },
      ),
    ).rejects.toThrow('provider rejected the application credentials');
    expect(transport.fetch).toHaveBeenLastCalledWith(
      new URL('https://directory.example/token'),
      expect.objectContaining({
        headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code' }),
      }),
    );
  });
  test('uses bounded pinned JSON discovery transport', async () => {
    transport.fetch.mockResolvedValue(Response.json({ issuer: 'https://directory.example' }));
    await expect(
      fetchGuardedJson(new URL('https://directory.example/config'), {
        timeoutMs: 5000,
        maxResponseBytes: 65536,
        redirect: 'error',
      }),
    ).resolves.toEqual({ issuer: 'https://directory.example' });
  });
});
