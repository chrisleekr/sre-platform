import { describe, expect, test } from 'vitest';
import {
  cfg,
  conn,
  fakeFetch,
  lookup,
  makeArgoCdConnector,
  type HostLookup,
  type Resp,
} from './test-helpers';

describe('probe', () => {
  const permission = (url: string): Resp | null => {
    if (!url.includes('/account/can-i/')) return null;
    const decoded = decodeURIComponent(url);
    const allowed =
      decoded.includes('/applications/get/payments/checkout') ||
      decoded.includes('/applications/get/payments/team-a/checkout') ||
      decoded.includes('/logs/get/payments/checkout') ||
      decoded.includes('/logs/get/payments/team-a/checkout');
    return { json: { value: allowed ? 'yes' : 'no' } };
  };

  const account = (url: string): Resp | null =>
    new URL(url).pathname === '/api/v1/account/sre-platform'
      ? { json: { name: 'sre-platform', enabled: true, capabilities: ['apiKey'] } }
      : null;

  const withPermissions =
    (handler: (url: string) => Resp) =>
    (url: string): Resp =>
      permission(url) ?? account(url) ?? handler(url);

  const healthy = (url: string): Resp => {
    const permissionResponse = permission(url);
    if (permissionResponse) return permissionResponse;
    const accountResponse = account(url);
    if (accountResponse) return accountResponse;
    if (url.includes('/session/userinfo'))
      return { json: { loggedIn: true, username: 'sre-platform' } };
    return {
      json: {
        items: [
          {
            metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-checkout' },
            spec: { project: 'payments' },
          },
        ],
      },
    };
  };

  test('healthy when userinfo is logged in and applications list is readable', async () => {
    const r = await conn(fakeFetch(healthy).impl).probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
    expect(r.checks?.canListApplications).toBe(true);
  });

  test('reports acknowledged TLS verification bypass without claiming trusted TLS', async () => {
    const result = await conn(fakeFetch(healthy).impl, {
      settings: { insecureSkipTLSVerify: true },
    }).probe();
    expect(result).toMatchObject({
      status: 'healthy',
      checks: { tlsTrusted: false, tlsVerificationDisabled: true },
    });
  });

  test('bounds small permission responses independently of the Application payload limit', async () => {
    const result = await conn(
      fakeFetch((url) => {
        if (url.includes('/session/userinfo'))
          return { json: { loggedIn: true, username: 'sre-platform' } };
        const accountResponse = account(url);
        if (accountResponse) return accountResponse;
        if (url.includes('/account/can-i/')) return { text: ' '.repeat(20 * 1024) };
        return { json: { items: [] } };
      }).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      failureCategory: 'provider_unavailable',
    });
  });

  test('applies one deadline to a maximum-scope permission probe', async () => {
    const delayedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/session/userinfo'))
        return new Response(JSON.stringify({ loggedIn: true, username: 'sre-platform' }));
      if (new URL(url).pathname === '/api/v1/account/sre-platform')
        return new Response(
          JSON.stringify({ name: 'sre-platform', enabled: true, capabilities: ['apiKey'] }),
        );
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        init?.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(init.signal?.reason);
          },
          { once: true },
        );
      });
      const decoded = decodeURIComponent(url);
      const requiredRead =
        decoded.includes('/applications/get/payments/app-') ||
        decoded.includes('/logs/get/payments/app-');
      return new Response(JSON.stringify({ value: requiredRead ? 'yes' : 'no' }));
    }) as typeof fetch;
    const startedAt = Date.now();
    const result = await conn(delayedFetch, {
      settings: {
        applications: Array.from({ length: 50 }, (_, index) => ({
          project: 'payments',
          name: `app-${index}`,
        })),
      },
    }).probe();
    expect(result.status).toBe('unhealthy');
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 10_000);

  test('includes unresolved DNS lookup in the shared probe deadline', async () => {
    const neverLookup: HostLookup = async () => new Promise<string[]>(() => {});
    const startedAt = Date.now();
    const result = await makeArgoCdConnector(cfg(), fakeFetch().impl, neverLookup).probe();
    expect(result).toMatchObject({ status: 'unhealthy', failureCategory: 'unreachable' });
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  }, 10_000);

  test('is unhealthy when a successful list contains no configured Application', async () => {
    const result = await conn(
      fakeFetch(
        withPermissions((url) =>
          url.includes('/session/userinfo')
            ? { json: { loggedIn: true, username: 'sre-platform' } }
            : { json: { items: [] } },
        ),
      ).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      authorized: true,
      checks: { canListApplications: true, hasScopedApplications: false },
      failureCategory: 'permission_denied',
    });
  });

  test('treats ArgoCD null items as an empty readable list without accepting malformed objects', async () => {
    const result = await conn(
      fakeFetch(
        withPermissions((url) =>
          url.includes('/session/userinfo')
            ? { json: { loggedIn: true, username: 'sre-platform' } }
            : { json: { items: null } },
        ),
      ).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      authorized: true,
      checks: { canListApplications: true, hasScopedApplications: false },
      failureCategory: 'permission_denied',
    });

    const malformed = await conn(
      fakeFetch(
        withPermissions((url) =>
          url.includes('/session/userinfo')
            ? { json: { loggedIn: true, username: 'sre-platform' } }
            : { json: { items: {} } },
        ),
      ).impl,
    ).probe();
    expect(malformed).toMatchObject({
      status: 'unhealthy',
      checks: { canListApplications: false },
      failureCategory: 'provider_unavailable',
    });
  });

  test('uses the bounded full Application response for any-namespace scope verification', async () => {
    const { impl, calls } = fakeFetch(
      withPermissions((url) =>
        url.includes('/session/userinfo')
          ? { json: { loggedIn: true, username: 'sre-platform' } }
          : {
              json: {
                items: [
                  {
                    metadata: { name: 'checkout', namespace: 'team-a', uid: 'uid-checkout' },
                    spec: { project: 'payments' },
                  },
                ],
              },
            },
      ),
    );
    const result = await conn(impl, {
      settings: {
        account: 'sre-platform',
        baseUrl: 'https://argocd.example.com',
        applicationsInAnyNamespace: true,
        applications: [{ project: 'payments', namespace: 'team-a', name: 'checkout' }],
      },
    }).probe();
    expect(result.status).toBe('healthy');
    const listUrl = new URL(calls.find((call) => call.url.includes('/applications'))!.url);
    expect(listUrl.searchParams.has('fields')).toBe(false);
  });

  test('is unhealthy when the token cannot list applications (403)', async () => {
    const r = await conn(
      fakeFetch(
        withPermissions((url) =>
          url.includes('/session/userinfo')
            ? { json: { loggedIn: true, username: 'sre-platform' } }
            : { ok: false, status: 403 },
        ),
      ).impl,
    ).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.checks?.canListApplications).toBe(false);
    expect(r.failureCategory).toBe('permission_denied');
  });

  test('unhealthy when the token authenticates but is not logged in', async () => {
    const r = await conn(
      fakeFetch((url) =>
        url.includes('/session/userinfo')
          ? { json: { loggedIn: false, username: 'sre-platform' } }
          : { json: { value: 'no' } },
      ).impl,
    ).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.warnings.some((w) => /identity does not match/.test(w))).toBe(true);
  });

  test('rejects admin or a token whose username does not match the configured account', async () => {
    for (const username of ['admin', 'another-account']) {
      const result = await conn(
        fakeFetch((url) =>
          url.includes('/session/userinfo')
            ? { json: { loggedIn: true, username } }
            : { json: { value: 'no' } },
        ).impl,
      ).probe();
      expect(result).toMatchObject({
        status: 'unhealthy',
        authorized: false,
        checks: { identityMatches: false },
        failureCategory: 'permission_denied',
      });
    }
  });

  test('rejects an authenticated account with effective access outside the selected scope', async () => {
    const result = await conn(
      fakeFetch((url) => {
        if (url.includes('/session/userinfo'))
          return { json: { loggedIn: true, username: 'sre-platform' } };
        const accountResponse = account(url);
        if (accountResponse) return accountResponse;
        if (url.includes('/account/can-i/')) return { json: { value: 'yes' } };
        return { json: { items: [] } };
      }).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      authorized: true,
      checks: { identityMatches: true, denySamplesPassed: false },
      failureCategory: 'permission_denied',
    });
  });

  test('rejects a token with a configured-application mutation grant', async () => {
    const result = await conn(
      fakeFetch((url) => {
        if (url.includes('/session/userinfo'))
          return { json: { loggedIn: true, username: 'sre-platform' } };
        const accountResponse = account(url);
        if (accountResponse) return accountResponse;
        if (decodeURIComponent(url).includes('/applications/sync/payments/checkout'))
          return { json: { value: 'yes' } };
        return permission(url) ?? { json: { items: [] } };
      }).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      checks: { denySamplesPassed: false },
      failureCategory: 'permission_denied',
    });
  });

  test('rejects a dedicated account with interactive login capability', async () => {
    const result = await conn(
      fakeFetch((url) => {
        if (url.includes('/session/userinfo'))
          return { json: { loggedIn: true, username: 'sre-platform' } };
        if (new URL(url).pathname === '/api/v1/account/sre-platform')
          return {
            json: { name: 'sre-platform', enabled: true, capabilities: ['apiKey', 'login'] },
          };
        return permission(url) ?? { json: { items: [] } };
      }).impl,
    ).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      checks: { requiredReadsVerified: false },
      failureCategory: 'permission_denied',
    });
  });

  test('unhealthy and unauthorized on 401', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 401 })).impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(true);
    expect(r.authorized).toBe(false);
    expect(r.warnings.some((w) => /credential was rejected/.test(w))).toBe(true);
  });

  test('unhealthy on a 5xx', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 503 })).impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.warnings.some((w) => /returned 503/.test(w))).toBe(true);
  });

  test('reachable:false when argocd does not respond', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await makeArgoCdConnector(cfg(), impl, lookup).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /did not respond/.test(w))).toBe(true);
  });

  test('distinguishes TLS certificate failures from connectivity failures', async () => {
    const tlsError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('self-signed certificate'), {
        code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
      }),
    });
    const impl = (async () => {
      throw tlsError;
    }) as unknown as typeof fetch;
    const result = await makeArgoCdConnector(cfg(), impl, lookup).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      reachable: false,
      checks: { tlsTrusted: false },
      failureCategory: 'tls',
    });
    expect(result.warnings).toContain('ArgoCD TLS certificate verification failed');
  });

  test('unhealthy config error when baseUrl is missing', async () => {
    const r = await conn(fakeFetch().impl, { settings: { baseUrl: '' } }).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /configuration is invalid/.test(w))).toBe(true);
  });

  test('fails closed when Application scope is missing', async () => {
    const r = await conn(fakeFetch().impl, { settings: { applications: [] } }).probe();
    expect(r).toMatchObject({
      status: 'unhealthy',
      reachable: false,
      authorized: false,
      failureCategory: 'permission_denied',
    });
  });
});
