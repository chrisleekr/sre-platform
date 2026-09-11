// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('a transient capability failure is retried while a successful answer is memoized', async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError('API is still starting'))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ localPasswordLogin: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  vi.stubGlobal('fetch', fetch);
  const { localLoginCapabilities } = await import('../local-session');

  await expect(localLoginCapabilities('http://localhost:43000')).rejects.toThrow(
    'API is still starting',
  );
  await expect(localLoginCapabilities('http://localhost:43000')).resolves.toEqual({
    localPasswordLogin: true,
    localDevelopmentLogin: false,
  });
  await expect(localLoginCapabilities('http://localhost:43000')).resolves.toEqual({
    localPasswordLogin: true,
    localDevelopmentLogin: false,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
