// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';

const configBody = (issuer: string) => ({
  productName: 'SRE Platform',
  productValueLine:
    'Built to work alongside you like a senior SRE: investigate problems, connect evidence across your systems, and help determine what to do next.',
  staffProvider: {
    providerId: 'staff-provider',
    displayName: 'Company SSO',
    issuer,
    browserClientId: 'staff-browser',
    authorizationEndpoint: `${issuer}/authorize`,
    scopes: ['openid', 'email', 'profile'],
    authorizationAudience: null,
  },
  signupProvider: null,
  registrationMode: 'approval_required' as const,
  supportUrl: null,
  termsUrl: null,
  privacyUrl: null,
  termsVersion: null,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

test('retries a transient failure and memoizes only the successful public configuration', async () => {
  const expected = configBody('https://staff.example.invalid');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
    .mockResolvedValueOnce(Response.json(expected));
  vi.stubGlobal('fetch', fetch);
  const { loadPublicConfig } = await import('../public-config');

  await expect(loadPublicConfig('/public-config')).rejects.toThrow(/503/);
  await expect(loadPublicConfig('/public-config')).resolves.toEqual({
    ...expected,
    signInProviders: [expected.staffProvider],
  });
  await expect(loadPublicConfig('/public-config')).resolves.toEqual({
    ...expected,
    signInProviders: [expected.staffProvider],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith('/public-config');
});

test('memoizes successful same-origin and split-origin URLs independently', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    return Response.json(
      configBody(
        url.startsWith('https://api.example.invalid/')
          ? 'https://split-staff.example.invalid'
          : 'https://same-staff.example.invalid',
      ),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const { loadPublicConfig } = await import('../public-config');

  await expect(loadPublicConfig('/public-config')).resolves.toMatchObject({
    staffProvider: { issuer: 'https://same-staff.example.invalid' },
  });
  await expect(
    loadPublicConfig('https://api.example.invalid/public-config'),
  ).resolves.toMatchObject({
    staffProvider: { issuer: 'https://split-staff.example.invalid' },
  });
  await loadPublicConfig('/public-config');
  await loadPublicConfig('https://api.example.invalid/public-config');
  expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
    '/public-config',
    'https://api.example.invalid/public-config',
  ]);
});

test('rejects a malformed response without poisoning a later retry', async () => {
  const expected = configBody('https://staff.example.invalid');
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ productName: 'SRE Platform' }))
    .mockResolvedValueOnce(Response.json(expected));
  vi.stubGlobal('fetch', fetch);
  const { loadPublicConfig } = await import('../public-config');

  await expect(loadPublicConfig('/public-config')).rejects.toThrow(/unexpected/i);
  await expect(loadPublicConfig('/public-config')).resolves.toEqual({
    ...expected,
    signInProviders: [expected.staffProvider],
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});

test('accepts open registration as a supported public mode', async () => {
  const expected = { ...configBody('https://staff.example.invalid'), registrationMode: 'open' };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(expected)),
  );
  const { loadPublicConfig } = await import('../public-config');

  await expect(loadPublicConfig('/public-config')).resolves.toEqual({
    ...expected,
    signInProviders: [expected.staffProvider],
  });
});
