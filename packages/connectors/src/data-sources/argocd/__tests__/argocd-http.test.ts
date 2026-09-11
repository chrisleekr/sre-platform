import { expect, test, vi } from 'vitest';
import { argoCdUrlError } from '@sre/contracts';
import { connect, resolveBase, aget } from '../client';
import { cfg, fakeFetch, makeArgoCdConnector } from './test-helpers';

test.each([
  'http://argocd-server.argocd.svc.cluster.local',
  'http://10.96.0.10',
  'http://172.16.0.10:8080',
  'http://192.168.1.10',
  'http://100.64.0.10',
  'http://[fd00::10]',
])('reads internal HTTP without TLS options: %s', async (baseUrl) => {
  const client = await connect(
    cfg({ settings: { baseUrl, insecureSkipTLSVerify: true } }),
    async () => ['10.96.0.10'],
  );
  const { impl, calls } = fakeFetch();
  await aget(impl, client, 'api/v1/applications');
  expect(calls).toEqual([
    expect.objectContaining({
      url: `${baseUrl.includes('.svc.') ? 'http://10.96.0.10' : baseUrl}/api/v1/applications`,
      authorization: 'Bearer token-abc',
      redirect: 'error',
      hasSignal: true,
      tls: undefined,
    }),
  ]);
});

test.each([
  ['http://public.example', ['8.8.8.8']],
  ['http://mixed.example', ['10.96.0.10', '8.8.8.8']],
  ['http://empty.example', []],
  ['http://metadata.example', ['169.254.169.254']],
  ['http://localhost', ['10.96.0.10']],
  ['http://127.0.0.1', ['10.96.0.10']],
  ['http://[::1]', ['10.96.0.10']],
  ['http://[2606:4700::1111]', []],
  ['http://[::ffff:8.8.8.8]', []],
  ['http://[2002:0808:0808::1]', []],
] as const)('rejects unsafe HTTP before reading a credential: %s', async (baseUrl, ips) => {
  const getCredential = vi.fn(async () => 'must-not-be-used');
  await expect(
    connect(cfg({ settings: { baseUrl }, getCredential }), async () => [...ips]),
  ).rejects.toThrow();
  expect(getCredential).not.toHaveBeenCalled();
});

test('allows public HTTPS and rechecks DNS on the next connection', async () => {
  await expect(
    resolveBase({ baseUrl: 'https://public.example' }, async () => ['8.8.8.8']),
  ).resolves.toBe('https://public.example');
  const lookup = vi.fn().mockResolvedValueOnce(['10.96.0.10']).mockResolvedValue(['8.8.8.8']);
  const settings = { baseUrl: 'http://internal.example' };
  await expect(resolveBase(settings, lookup)).resolves.toBe('http://10.96.0.10');
  await expect(resolveBase(settings, lookup)).rejects.toThrow(/HTTP requires an internal address/);
});

test('pins HTTP requests to the validated address and preserves the original Host header', async () => {
  const lookup = vi.fn().mockResolvedValueOnce(['10.96.0.10']).mockResolvedValue(['8.8.8.8']);
  const client = await connect(
    cfg({ settings: { baseUrl: 'http://internal.example:8080/argo' } }),
    lookup,
  );
  const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
  await aget(fetchImpl, client, 'api/v1/applications');
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledWith(
    'http://10.96.0.10:8080/argo/api/v1/applications',
    expect.objectContaining({
      headers: expect.objectContaining({ Host: 'internal.example:8080' }),
      redirect: 'error',
    }),
  );
});

test('snapshot links retain the configured hostname while transport uses its private IP', async () => {
  const { impl, calls } = fakeFetch(() => ({
    json: {
      items: [
        {
          metadata: { name: 'checkout', namespace: 'argocd', uid: 'checkout' },
          spec: { project: 'payments' },
          status: {},
        },
      ],
    },
  }));
  const connector = makeArgoCdConnector(
    cfg({ settings: { baseUrl: 'http://internal.example:8080/argo' } }),
    impl,
    async () => ['10.96.0.10'],
  );
  const snapshots = await connector.snapshot();
  expect(calls[0]!.url).toMatch(/^http:\/\/10\.96\.0\.10:8080\/argo\/api\//);
  expect(snapshots[0]!.metadata.url).toBe(
    'http://internal.example:8080/argo/applications/argocd/checkout',
  );
});

test('HTTP probe reports plaintext risk without claiming trusted TLS', async () => {
  const { impl } = fakeFetch((url) => {
    if (url.endsWith('/session/userinfo'))
      return { json: { loggedIn: true, username: 'proj:payments:reader' } };
    if (url.includes('/account/can-i/'))
      return {
        json: {
          value: /\/(applications|logs)\/get\/payments\/checkout$/.test(decodeURIComponent(url))
            ? 'yes'
            : 'no',
        },
      };
    return { json: { items: [{ metadata: { name: 'checkout' }, spec: { project: 'payments' } }] } };
  });
  const result = await makeArgoCdConnector(
    cfg({ settings: { baseUrl: 'http://internal.example', identity: 'proj:payments:reader' } }),
    impl,
    async () => ['10.96.0.10'],
  ).probe();
  expect(result.status).toBe('healthy');
  expect(result.warnings).toContain('HTTP sends project tokens and API responses unencrypted.');
  expect(result.checks).not.toHaveProperty('tlsTrusted');
  expect(result.checks).not.toHaveProperty('tlsVerificationDisabled');
});

test.each([
  '',
  'not a URL',
  'ftp://argo.example',
  'https://user:secret@argo.example',
  'https://argo.example?token=secret',
  'https://argo.example#secret',
  `https://${'x'.repeat(2048)}.example`,
])('returns a safe syntax error: %s', (value) => {
  const error = argoCdUrlError(value);
  expect(error).toBeTruthy();
  expect(error).not.toContain('secret');
});
