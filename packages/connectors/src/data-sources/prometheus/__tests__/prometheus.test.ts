import { describe, expect, it, test } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import type { ConnectorTool } from '../../../types';
import { buildGetUrl, makePrometheusConnector } from '../index';
import { abortableFetch, expectCancelledInFlight } from '../../../__tests__/request-signal.fixture';

interface Call {
  url: string;
  method: string;
  authorization?: string;
  headers: Record<string, string>;
  body?: string;
  form?: URLSearchParams;
  redirect?: string;
  tls?: { ca?: string; cert?: string; key?: string; rejectUnauthorized?: boolean };
  hasSignal: boolean;
}

/** A fake fetch; records method, headers, form body, tls, and safety options per call. */
function fakeFetch(handler?: (url: string) => { ok?: boolean; status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const impl = (async (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      signal?: unknown;
      redirect?: string;
      tls?: Call['tls'];
    },
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.Authorization,
      headers,
      body: init?.body,
      form: init?.body ? new URLSearchParams(init.body) : undefined,
      redirect: init?.redirect,
      tls: init?.tls,
      hasSignal: init?.signal != null,
    });
    const r = handler?.(String(url)) ?? {};
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {} };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** A public IP so the SSRF guard admits the default test host. */
const lookup: HostLookup = async () => ['93.184.216.34'];

function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 't1',
    type: 'prometheus',
    settings: { baseUrl: 'https://prom.example.com' },
    getCredential: async () => JSON.stringify({ type: 'bearer', token: 'tok-1' }),
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test Prometheus',
  };
}

function conn(
  fetchImpl: ReturnType<typeof fakeFetch>['impl'],
  overrides: Partial<ConnectorConfig> = {},
) {
  return makePrometheusConnector(cfg(overrides), fetchImpl, lookup);
}

function toolNamed(c: ReturnType<typeof makePrometheusConnector>, name: string): ConnectorTool {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('makePrometheusConnector tool set', () => {
  test('declares the 10 tools in order', () => {
    const c = makePrometheusConnector(cfg(), fakeFetch().impl, lookup);
    expect([...c.tools()].map((t) => t.name)).toEqual([
      'query',
      'query_range',
      'series',
      'labels',
      'label_values',
      'metadata',
      'targets',
      'rules',
      'alerts',
      'api_get',
    ]);
  });
});

describe('buildGetUrl', () => {
  const base = 'https://prom.example.com';
  it('builds an absolute url under /api and encodes query', () => {
    expect(buildGetUrl(base, 'api/v1/targets', { state: 'active' })).toBe(
      'https://prom.example.com/api/v1/targets?state=active',
    );
  });
  it('appends array values (match[]) rather than overwriting', () => {
    const u = new URL(buildGetUrl(base, 'api/v1/series', { 'match[]': ['up', '{job="api"}'] }));
    expect(u.searchParams.getAll('match[]')).toEqual(['up', '{job="api"}']);
  });
  it('rejects a path escaping the host', () => {
    expect(() => buildGetUrl(base, 'https://evil.example.com/api/v1/query')).toThrow(
      /escapes the configured host/,
    );
  });
  it('rejects a path outside /api via traversal', () => {
    expect(() => buildGetUrl(base, 'api/../secret')).toThrow(/must be under \/api\//);
  });
  it('validates under a path-prefixed base (Mimir/Cortex/Thanos)', () => {
    const prefixed = 'https://mimir.example.com/prometheus';
    expect(buildGetUrl(prefixed, 'api/v1/targets')).toBe(
      'https://mimir.example.com/prometheus/api/v1/targets',
    );
    // Traversal off the prefixed base is still refused.
    expect(() => buildGetUrl(prefixed, 'api/../secret')).toThrow(/must be under \/api\//);
  });
});

describe('auth strategies', () => {
  test('bearer sets Authorization: Bearer', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'alerts').run({});
    expect(calls[0]!.authorization).toBe('Bearer tok-1');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('basic sets Authorization: Basic base64(user:pass)', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      getCredential: async () => JSON.stringify({ type: 'basic', username: 'u', password: 'p' }),
    });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.authorization).toBe('Basic dTpw');
  });

  test('header sets a custom header, no Authorization', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      getCredential: async () =>
        JSON.stringify({ type: 'header', name: 'X-Scope-OrgID', value: 'tenant-7' }),
    });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.headers['X-Scope-OrgID']).toBe('tenant-7');
    expect(calls[0]!.authorization).toBeUndefined();
  });

  test('none sends no Authorization header', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, { getCredential: async () => JSON.stringify({ type: 'none' }) });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.authorization).toBeUndefined();
  });

  test('mtls attaches the client cert/key and preserves the server caCert', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: { baseUrl: 'https://prom.example.com', caCert: 'CA-PEM' },
      getCredential: async () => JSON.stringify({ type: 'mtls', cert: 'CERT-PEM', key: 'KEY-PEM' }),
    });
    await toolNamed(c, 'alerts').run({});
    // The mtls client cert/key merge on top of the server-trust ca — all three survive.
    expect(calls[0]!.tls).toEqual({ ca: 'CA-PEM', cert: 'CERT-PEM', key: 'KEY-PEM' });
  });

  test('rejects a non-JSON credential', async () => {
    const c = conn(fakeFetch().impl, { getCredential: async () => 'raw-string' });
    await expect(toolNamed(c, 'alerts').run({})).rejects.toThrow(/credential must be JSON/);
  });

  test('rejects an unknown auth type', async () => {
    const c = conn(fakeFetch().impl, {
      getCredential: async () => JSON.stringify({ type: 'kerberos' }),
    });
    await expect(toolNamed(c, 'alerts').run({})).rejects.toThrow(/credential must be JSON/);
  });
});

describe('server TLS from settings', () => {
  test('caCert pins the CA', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, { settings: { baseUrl: 'https://prom.example.com', caCert: 'CA-PEM' } });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.tls?.ca).toBe('CA-PEM');
  });

  test('insecureSkipTLSVerify disables verification (explicit opt-in)', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: { baseUrl: 'https://prom.example.com', insecureSkipTLSVerify: true },
    });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.tls?.rejectUnauthorized).toBe(false);
  });

  test('caCert and insecureSkipTLSVerify together', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, {
      settings: {
        baseUrl: 'https://prom.example.com',
        caCert: 'CA-PEM',
        insecureSkipTLSVerify: true,
      },
    });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.tls).toEqual({ ca: 'CA-PEM', rejectUnauthorized: false });
  });
});

describe('SSRF / transport', () => {
  test('accepts an HTTP baseUrl', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, { settings: { baseUrl: 'http://prom.example.com' } });
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.url).toBe('http://prom.example.com/api/v1/alerts');
  });
  test('rejects a non-HTTP protocol', async () => {
    const c = conn(fakeFetch().impl, { settings: { baseUrl: 'ftp://prom.example.com' } });
    await expect(toolNamed(c, 'alerts').run({})).rejects.toThrow(/must be http or https/);
  });
  test('rejects mutual TLS over HTTP', async () => {
    const c = conn(fakeFetch().impl, {
      settings: { baseUrl: 'http://prom.example.com', authType: 'mtls' },
    });
    await expect(toolNamed(c, 'alerts').run({})).rejects.toThrow(/mutual TLS requires HTTPS/);
  });
  test('rejects a loopback literal even under allowPrivate', async () => {
    const c = conn(fakeFetch().impl, { settings: { baseUrl: 'https://127.0.0.1:9090' } });
    await expect(toolNamed(c, 'alerts').run({})).rejects.toThrow(/not allowed/);
  });
  test('accepts a loopback literal only when the development option is explicit', async () => {
    const { impl, calls } = fakeFetch();
    const c = makePrometheusConnector(
      cfg({ settings: { baseUrl: 'http://127.0.0.1:9090' } }),
      impl,
      lookup,
      { allowedLoopbackOrigins: ['http://127.0.0.1:9090'] },
    );
    await toolNamed(c, 'alerts').run({});
    expect(calls[0]!.url).toBe('http://127.0.0.1:9090/api/v1/alerts');
  });
});

describe('query (instant)', () => {
  test('POSTs form-encoded PromQL to /api/v1/query', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'query').run({ query: 'up' });
    expect(calls[0]!.url).toBe('https://prom.example.com/api/v1/query');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.form?.get('query')).toBe('up');
    expect(calls[0]!.form?.get('time')).toBeNull();
  });

  test('resolves an optional relative time to unix seconds', async () => {
    const { impl, calls } = fakeFetch();
    const before = Math.floor(Date.now() / 1000);
    await toolNamed(conn(impl), 'query').run({ query: 'up', time: 'now-5m' });
    const time = Number(calls[0]!.form?.get('time'));
    expect(before - time - 300).toBeLessThanOrEqual(2);
    expect(before - time - 300).toBeGreaterThanOrEqual(-2);
  });
});

describe('query_range', () => {
  test('defaults step to ~250 points across the window', async () => {
    const { impl, calls } = fakeFetch();
    // 10h = 36000s → ceil(36000/250) = 144s
    await toolNamed(conn(impl), 'query_range').run({ query: 'up', start: 'now-10h', end: 'now' });
    expect(calls[0]!.url).toBe('https://prom.example.com/api/v1/query_range');
    expect(calls[0]!.form?.get('step')).toBe('144');
  });

  test('parses a duration step (1m → 60s)', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'query_range').run({
      query: 'up',
      start: 'now-1h',
      end: 'now',
      step: '1m',
    });
    expect(calls[0]!.form?.get('step')).toBe('60');
  });

  test('rejects a range too wide for the step (>11000 points)', async () => {
    const c = conn(fakeFetch().impl);
    await expect(
      toolNamed(c, 'query_range').run({ query: 'up', start: 'now-100h', end: 'now', step: '1s' }),
    ).rejects.toThrow(/range too wide for step/);
  });

  test('rejects a non-positive step', async () => {
    const c = conn(fakeFetch().impl);
    await expect(
      toolNamed(c, 'query_range').run({ query: 'up', start: 'now-1h', end: 'now', step: '0s' }),
    ).rejects.toThrow(/step must be positive/);
  });
});

describe('discovery + operational tools', () => {
  test('series appends match[] and resolves times', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'series').run({ match: ['up', '{job="api"}'] });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/series');
    expect(u.searchParams.getAll('match[]')).toEqual(['up', '{job="api"}']);
  });

  test('labels appends optional match[] and omits it when absent', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'labels').run({ match: ['{job="api"}'] });
    let u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/labels');
    expect(u.searchParams.getAll('match[]')).toEqual(['{job="api"}']);
    await toolNamed(conn(impl), 'labels').run({});
    u = new URL(calls[1]!.url);
    expect(u.searchParams.has('match[]')).toBe(false);
  });

  test('metadata passes metric and a numeric limit as query params', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'metadata').run({ metric: 'up', limit: 50 });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/metadata');
    expect(u.searchParams.get('metric')).toBe('up');
    expect(u.searchParams.get('limit')).toBe('50');
  });

  test('label_values encodes the label name path segment', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'label_values').run({ name: 'a/b' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/label/a%2Fb/values');
  });

  test('targets passes the state filter', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'targets').run({ state: 'dropped' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/targets');
    expect(u.searchParams.get('state')).toBe('dropped');
  });

  test('rules passes the type filter', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'rules').run({ type: 'alert' });
    expect(new URL(calls[0]!.url).searchParams.get('type')).toBe('alert');
  });
});

describe('api_get', () => {
  test('GETs an arbitrary /api path', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/v1/status/config' });
    expect(calls[0]!.url).toBe('https://prom.example.com/api/v1/status/config');
    expect(calls[0]!.method).toBe('GET');
  });

  test('throws on a non-ok status', async () => {
    const c = conn(fakeFetch(() => ({ ok: false, status: 404 })).impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/status/config' })).rejects.toThrow(
      /prometheus api 404/,
    );
  });

  test('rejects a traversal path', async () => {
    const c = conn(fakeFetch().impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/../secret' })).rejects.toThrow(
      /must be under \/api\//,
    );
  });
});

describe('fetchTriageContext', () => {
  const alertsResp = {
    data: {
      alerts: [
        {
          labels: { alertname: 'HighErrorRate', service: 'api', severity: 'critical' },
          state: 'firing',
          activeAt: '2026-07-01T00:00:00Z',
        },
        { labels: { alertname: 'DiskFull', service: 'other' }, state: 'firing' },
        // pending (condition true, not past `for:`) — excluded even though it matches the service.
        { labels: { alertname: 'Warming', service: 'api' }, state: 'pending' },
      ],
    },
  };

  test('pulls firing alerts and scopes to the service (excludes pending)', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: alertsResp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/alerts');
    expect(ctx.source).toBe('prometheus');
    const firing = (ctx.data as { firingAlerts: { alertname?: string }[] }).firingAlerts;
    expect(firing).toEqual([
      {
        alertname: 'HighErrorRate',
        state: 'firing',
        severity: 'critical',
        activeAt: '2026-07-01T00:00:00Z',
        labels: { alertname: 'HighErrorRate', service: 'api', severity: 'critical' },
      },
    ]);
  });

  test('falls back to all firing alerts when none match the service', async () => {
    const { impl } = fakeFetch(() => ({ json: alertsResp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'nomatch', windowMinutes: 30 });
    expect((ctx.data as { firingAlerts: unknown[] }).firingAlerts).toHaveLength(2);
  });
});

describe('snapshot', () => {
  test('is unsupported for this on-demand connector', async () => {
    await expect(conn(fakeFetch().impl).snapshot()).rejects.toThrow(
      /does not support snapshot polling/,
    );
  });
});

describe('probe', () => {
  test('healthy when the trivial query returns 200', async () => {
    const r = await conn(fakeFetch(() => ({ ok: true, status: 200 })).impl).probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
  });

  test('unhealthy and unauthorized on 401', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 401 })).impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(true);
    expect(r.authorized).toBe(false);
    expect(r.warnings.some((w) => /credential was rejected/.test(w))).toBe(true);
  });

  test('reports an authentication redirect as reachable but unauthorized without following it', async () => {
    const provider = fakeFetch(() => ({ ok: false, status: 302 }));
    const r = await conn(provider.impl).probe();
    expect(r).toMatchObject({
      status: 'unhealthy',
      reachable: true,
      authorized: false,
      failureCategory: 'permission_denied',
    });
    expect(r.warnings).toContain(
      'prometheus redirected the API request to an authentication gateway',
    );
    expect(provider.calls[0]!.redirect).toBe('manual');
  });

  test('unhealthy on a 5xx (no prior signal to preserve health on)', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 503 })).impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(true);
    expect(r.warnings.some((w) => /returned 503/.test(w))).toBe(true);
  });

  test('reachable:false when the api does not respond', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await makePrometheusConnector(cfg(), impl, lookup).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
  });

  test('unhealthy config error when baseUrl is missing', async () => {
    const r = await conn(fakeFetch().impl, { settings: {} }).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /baseUrl is required/.test(w))).toBe(true);
  });
});

describe('tool cancellation', () => {
  it('aborts an in-flight Prometheus request when the calling investigation is cancelled', async () => {
    const { impl, signals } = abortableFetch();
    const tool = toolNamed(conn(impl), 'query');
    await expectCancelledInFlight((signal) => tool.run({ query: 'up' }, { signal }), signals);
  });
});
