import { describe, expect, test, vi } from 'vitest';
import { fetchPinnedHttps, type PinnedHttpsTransport } from '../guarded-https';

const PUBLIC_IP = '8.8.8.8';

function response(
  body: ConstructorParameters<typeof Response>[0],
  init?: ResponseInit,
): Promise<Response> {
  return Promise.resolve(new Response(body, init));
}

describe('pinned HTTPS requests', () => {
  test('resolves once, rejects any blocked answer, and never opens the transport', async () => {
    const transport = vi.fn<PinnedHttpsTransport>();

    await expect(
      fetchPinnedHttps('https://issuer.example/.well-known/openid-configuration', {
        lookup: async () => [PUBLIC_IP, '169.254.169.254'],
        transport,
      }),
    ).rejects.toThrow(/not allowed/i);
    expect(transport).not.toHaveBeenCalled();
  });

  test.each(['192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', 'ff02::1'])(
    'rejects non-global destination %s before opening the transport',
    async (address) => {
      const transport = vi.fn<PinnedHttpsTransport>();
      await expect(
        fetchPinnedHttps('https://issuer.example/metadata', {
          lookup: async () => [address],
          transport,
        }),
      ).rejects.toThrow(/not allowed/i);
      expect(transport).not.toHaveBeenCalled();
    },
  );

  test('connects to the validated address while preserving TLS hostname verification', async () => {
    const transport = vi.fn<PinnedHttpsTransport>(() => response('{"ok":true}', { status: 200 }));

    const result = await fetchPinnedHttps('https://issuer.example/metadata', {
      lookup: async () => [PUBLIC_IP],
      transport,
    });

    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        address: PUBLIC_IP,
        servername: 'issuer.example',
        rejectUnauthorized: true,
        url: new URL('https://issuer.example/metadata'),
      }),
    );
    expect(await result.json()).toEqual({ ok: true });
  });

  test.each([
    [
      'redirect',
      () => response(null, { status: 302, headers: { location: 'https://elsewhere.test' } }),
    ],
    ['oversize body', () => response('x'.repeat(65), { status: 200 })],
  ])('fails closed on a %s', async (_label, reply) => {
    await expect(
      fetchPinnedHttps('https://issuer.example/metadata', {
        lookup: async () => [PUBLIC_IP],
        transport: reply,
        maxResponseBytes: 64,
      }),
    ).rejects.toThrow();
  });

  test('aborts a transport that exceeds its deadline', async () => {
    const transport: PinnedHttpsTransport = ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });

    await expect(
      fetchPinnedHttps('https://issuer.example/metadata', {
        lookup: async () => [PUBLIC_IP],
        transport,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/timeout/i);
  });
});
