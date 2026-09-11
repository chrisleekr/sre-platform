import { describe, expect, it, test } from 'vitest';
import {
  buildGetUrl,
  cfg,
  conn,
  fakeFetch,
  lookup,
  makeArgoCdConnector,
  multiCfg,
  toolNamed,
} from './test-helpers';

describe('makeArgoCdConnector tool set', () => {
  test('declares the scoped investigation tools in order', () => {
    const c = makeArgoCdConnector(cfg(), fakeFetch().impl, lookup);
    expect(c.tools().map((t) => t.name)).toEqual([
      'list_applications',
      'get_application',
      'get_resource_tree',
      'get_managed_resources',
      'get_application_events',
      'get_application_logs',
      'api_get',
    ]);
  });
});

describe('multi-project connector', () => {
  test('verifies each project-role identity and reports project evidence', async () => {
    const accessRole = 'sre-platform-a1b2c3d4';
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      const token = (init?.headers as Record<string, string> | undefined)?.Authorization?.replace(
        'Bearer ',
        '',
      );
      const project = token === 'payments-token' ? 'payments' : 'identity';
      if (url.endsWith('/api/v1/session/userinfo'))
        return new Response(
          JSON.stringify({ loggedIn: true, username: `proj:${project}:${accessRole}` }),
        );
      if (url.includes('/api/v1/account/can-i/')) {
        const decoded = decodeURIComponent(url);
        const application = project === 'payments' ? 'checkout' : 'login';
        const allowed =
          decoded.includes(`/applications/get/${project}/${application}`) ||
          decoded.includes(`/logs/get/${project}/${application}`);
        return new Response(JSON.stringify({ value: allowed ? 'yes' : 'no' }));
      }
      if (new URL(url).pathname.endsWith('/api/v1/applications')) {
        const application = project === 'payments' ? 'checkout' : 'login';
        return new Response(
          JSON.stringify({
            items: [
              {
                metadata: { name: application, namespace: 'argocd', uid: `uid-${application}` },
                spec: { project },
                status: {},
              },
            ],
          }),
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;

    await expect(
      makeArgoCdConnector(multiCfg(accessRole), fetchImpl, lookup).probe(),
    ).resolves.toMatchObject({
      status: 'healthy',
      checks: {
        allProjectIdentitiesMatch: true,
        allProjectReadsVerified: true,
        allProjectDenySamplesPassed: true,
        allProjectsReadable: true,
        allProjectsHaveApplications: true,
      },
      details: {
        projects: [
          { project: 'payments', status: 'healthy' },
          { project: 'identity', status: 'healthy' },
        ],
      },
    });
  });

  test('routes an application tool through the selected project token', async () => {
    const { impl, calls } = fakeFetch((url) =>
      new URL(url).pathname.endsWith('/api/v1/applications/login')
        ? {
            json: {
              metadata: { name: 'login', namespace: 'argocd', uid: 'uid-login' },
              spec: { project: 'identity' },
              status: {},
            },
          }
        : {},
    );
    await toolNamed(makeArgoCdConnector(multiCfg(), impl, lookup), 'get_application').run({
      project: 'identity',
      name: 'login',
    });
    expect(calls[0]?.authorization).toBe('Bearer identity-token');
  });

  test('keeps healthy project snapshots and exposes a sanitized partial failure marker', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const token = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (token === 'Bearer identity-token') throw new Error('provider unavailable');
      return new Response(
        JSON.stringify({
          items: [
            {
              metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-checkout' },
              spec: { project: 'payments' },
              status: {},
            },
          ],
        }),
      );
    }) as typeof fetch;
    const connector = makeArgoCdConnector(multiCfg(), fetchImpl, lookup);
    const snapshots = await connector.snapshot();
    expect(snapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entityId: 'application:payments/argocd/checkout' }),
        expect.objectContaining({
          entityId: 'project-error:identity',
          metadata: {
            kind: 'connector_error',
            project: 'identity',
            failureCategory: 'unreachable',
          },
        }),
      ]),
    );
    expect(connector.pollEvidence?.()).toMatchObject({
      errorCount: 1,
      failureCategory: 'partial_project_failure',
      cursor: {
        projects: [
          { project: 'payments', status: 'healthy' },
          { project: 'identity', status: 'unhealthy', failureCategory: 'unreachable' },
        ],
      },
    });
  });
});

describe('buildGetUrl', () => {
  const base = 'https://argocd.example.com';
  it('builds an absolute url under /api and encodes query', () => {
    expect(buildGetUrl(base, 'api/v1/applications', { selector: 'app=web' })).toBe(
      'https://argocd.example.com/api/v1/applications?selector=app%3Dweb',
    );
  });
  it('appends array values rather than overwriting', () => {
    const u = new URL(buildGetUrl(base, 'api/v1/applications', { projects: ['a', 'b'] }));
    expect(u.searchParams.getAll('projects')).toEqual(['a', 'b']);
  });
  it('rejects a path escaping the host', () => {
    expect(() => buildGetUrl(base, 'https://evil.example.com/api/v1/applications')).toThrow(
      /escapes the configured host/,
    );
  });
  it('rejects a path outside /api via traversal', () => {
    expect(() => buildGetUrl(base, 'api/../secret')).toThrow(/must be under \/api\//);
  });
  it('validates under a path-prefixed base (ingress subpath)', () => {
    const prefixed = 'https://ingress.example.com/argocd';
    expect(buildGetUrl(prefixed, 'api/v1/applications')).toBe(
      'https://ingress.example.com/argocd/api/v1/applications',
    );
    expect(() => buildGetUrl(prefixed, 'api/../secret')).toThrow(/must be under \/api\//);
  });
});

describe('auth + transport', () => {
  test('sends the token as Bearer, no-redirect, with a timeout signal', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/version' });
    expect(calls[0]!.authorization).toBe('Bearer token-abc');
    expect(calls[0]!.accept).toBe('application/json');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('trims the stored token', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl, { getCredential: async () => '  tok-2\n' }), 'api_get').run({
      path: 'api/v1/version',
    });
    expect(calls[0]!.authorization).toBe('Bearer tok-2');
  });

  test('rejects an empty credential', async () => {
    const c = conn(fakeFetch().impl, { getCredential: async () => '   ' });
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/version' })).rejects.toThrow(
      /API token.*required/,
    );
  });
});

describe('server TLS from settings', () => {
  test('caCert pins the CA', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: { baseUrl: 'https://argocd.example.com', caCert: 'CA-PEM' },
    });
    await toolNamed(c, 'api_get').run({ path: 'api/v1/version' });
    expect(calls[0]!.tls?.ca).toBe('CA-PEM');
  });

  test('insecureSkipTLSVerify disables verification (explicit opt-in)', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: { baseUrl: 'https://argocd.example.com', insecureSkipTLSVerify: true },
    });
    await toolNamed(c, 'api_get').run({ path: 'api/v1/version' });
    expect(calls[0]!.tls?.rejectUnauthorized).toBe(false);
  });

  test('caCert and insecureSkipTLSVerify together', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: {
        baseUrl: 'https://argocd.example.com',
        caCert: 'CA-PEM',
        insecureSkipTLSVerify: true,
      },
    });
    await toolNamed(c, 'api_get').run({ path: 'api/v1/version' });
    expect(calls[0]!.tls).toEqual({ ca: 'CA-PEM', rejectUnauthorized: false });
  });
});

describe('SSRF', () => {
  test('rejects a public HTTP baseUrl', async () => {
    const c = conn(fakeFetch().impl, { settings: { baseUrl: 'http://argocd.example.com' } });
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/version' })).rejects.toThrow(
      /HTTP requires an internal address/,
    );
  });
  test('rejects a loopback literal even under allowPrivate', async () => {
    const c = conn(fakeFetch().impl, { settings: { baseUrl: 'https://127.0.0.1:8080' } });
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/version' })).rejects.toThrow(
      /not allowed/,
    );
  });
});
