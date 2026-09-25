import { describe, expect, it, test } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { ConnectorTool } from '../../../types';
import { buildGetUrl, makeDatadogConnector } from '../connector';
import { abortableFetch, expectCancelledInFlight } from '../../../__tests__/request-signal.fixture';

interface Call {
  url: string;
  method: string;
  apiKey?: string;
  appKey?: string;
  body?: unknown;
  redirect?: string;
  hasSignal: boolean;
}

/** A fake fetch routing by URL substring; records method, keys, body, and safety options per call. */
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
    },
  ) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      apiKey: init?.headers?.['DD-API-KEY'],
      appKey: init?.headers?.['DD-APPLICATION-KEY'],
      body: init?.body ? JSON.parse(init.body) : undefined,
      redirect: init?.redirect,
      hasSignal: init?.signal != null,
    });
    const r = handler?.(String(url)) ?? {};
    return { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {} };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 't1',
    type: 'datadog',
    settings: { site: 'ap2.datadoghq.com' },
    getCredential: async () => JSON.stringify({ apiKey: 'dd-api', appKey: 'dd-app' }),
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test Datadog',
  };
}

function toolNamed(c: ReturnType<typeof makeDatadogConnector>, name: string): ConnectorTool {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('buildGetUrl', () => {
  const base = 'https://api.ap2.datadoghq.com';
  it('builds an absolute url under /api and encodes query', () => {
    expect(buildGetUrl(base, 'api/v1/monitor', { per_page: 1 })).toBe(
      'https://api.ap2.datadoghq.com/api/v1/monitor?per_page=1',
    );
  });
  it('rejects a path escaping the host', () => {
    expect(() => buildGetUrl(base, 'https://evil.example.com/api/v1/monitor')).toThrow(
      /escapes the configured host/,
    );
  });
  it('rejects a path outside /api via traversal', () => {
    expect(() => buildGetUrl(base, 'api/../secret')).toThrow(/must be under \/api\//);
  });
});

describe('makeDatadogConnector site + credentials', () => {
  test('rejects an unknown site', async () => {
    const c = makeDatadogConnector(cfg({ settings: { site: 'evil.example.com' } }));
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/monitor' })).rejects.toThrow(
      /unknown site/,
    );
  });

  test('sends both keys as headers to the pinned site', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'api_get').run({ path: 'api/v1/monitor' });
    expect(calls[0]!.url).toBe('https://api.ap2.datadoghq.com/api/v1/monitor');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.apiKey).toBe('dd-api');
    expect(calls[0]!.appKey).toBe('dd-app');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('rejects a non-JSON credential', async () => {
    const c = makeDatadogConnector(
      cfg({ getCredential: async () => 'raw-string' }),
      fakeFetch().impl,
    );
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/monitor' })).rejects.toThrow(
      /credential must be JSON/,
    );
  });

  test('rejects a JSON credential missing appKey', async () => {
    const c = makeDatadogConnector(
      cfg({ getCredential: async () => JSON.stringify({ apiKey: 'x' }) }),
      fakeFetch().impl,
    );
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/monitor' })).rejects.toThrow(
      /credential must be JSON/,
    );
  });

  test('api_get throws on a non-ok status', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(() => ({ ok: false, status: 404 })).impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/v1/monitor' })).rejects.toThrow(
      /datadog api 404/,
    );
  });
});

describe('search tool', () => {
  test('logs: flat filter body to the logs search path, newest-first', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'search').run({ domain: 'logs', query: 'service:api status:error' });
    expect(calls[0]!.url).toBe('https://api.ap2.datadoghq.com/api/v2/logs/events/search');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toEqual({
      filter: { query: 'service:api status:error', from: 'now-15m', to: 'now' },
      sort: '-timestamp',
      page: { limit: 25 },
    });
  });

  test('spans: wraps filter in data.attributes with search_request type', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'search').run({ domain: 'spans', query: '*', limit: 5 });
    expect(calls[0]!.url).toBe('https://api.ap2.datadoghq.com/api/v2/spans/events/search');
    expect(calls[0]!.body).toEqual({
      data: {
        attributes: {
          filter: { query: '*', from: 'now-15m', to: 'now' },
          sort: '-timestamp',
          page: { limit: 5 },
        },
        type: 'search_request',
      },
    });
  });

  test('error_tracking: epoch-ms bounds, track=trace, no filter wrapper', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'search').run({
      domain: 'error_tracking',
      query: 'service:api',
      from: '2020-09-17T11:00:00Z',
      to: '2020-09-17T12:00:00Z',
    });
    const attrs = (calls[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.query).toBe('service:api');
    expect(attrs.track).toBe('trace');
    expect(attrs.from).toBe(Date.parse('2020-09-17T11:00:00Z'));
    expect(attrs.to).toBe(Date.parse('2020-09-17T12:00:00Z'));
  });

  test('error_tracking: resolves a bare epoch (seconds promoted to ms, millis kept)', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'search').run({
      domain: 'error_tracking',
      from: '1600338000', // seconds
      to: '1600338000000', // millis
    });
    const attrs = (calls[0]!.body as { data: { attributes: Record<string, unknown> } }).data
      .attributes;
    expect(attrs.from).toBe(1600338000 * 1000);
    expect(attrs.to).toBe(1600338000000);
  });

  test('error_tracking: rejects an unparseable time', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch().impl);
    await expect(
      toolNamed(c, 'search').run({ domain: 'error_tracking', from: 'not-a-time' }),
    ).rejects.toThrow(/unparseable time/);
  });

  test('throws on a non-ok status', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(() => ({ ok: false, status: 500 })).impl);
    await expect(toolNamed(c, 'search').run({ domain: 'logs' })).rejects.toThrow(/datadog api 500/);
  });

  test('clamps limit above the max', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    await toolNamed(c, 'search').run({ domain: 'events', limit: 9999 });
    expect((calls[0]!.body as { page: { limit: number } }).page.limit).toBe(200);
  });
});

describe('query_metrics tool', () => {
  test('resolves relative window to unix seconds on the v1 query endpoint', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeDatadogConnector(cfg(), impl);
    const before = Math.floor(Date.now() / 1000);
    await toolNamed(c, 'query_metrics').run({ query: 'avg:system.cpu.user{*}', from: 'now-1h' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/v1/query');
    expect(u.searchParams.get('query')).toBe('avg:system.cpu.user{*}');
    const from = Number(u.searchParams.get('from'));
    const to = Number(u.searchParams.get('to'));
    // from is ~1h before to; to is ~now (allow a few seconds of drift).
    expect(to - from).toBe(3600);
    expect(Math.abs(to - before)).toBeLessThan(5);
  });
});

describe('fetchTriageContext', () => {
  test('pulls recent error logs for the service and maps them', async () => {
    const logsResp = {
      data: [
        {
          attributes: {
            timestamp: '2026-07-01T00:00:00Z',
            status: 'error',
            service: 'api',
            message: 'boom',
          },
        },
      ],
    };
    const { impl, calls } = fakeFetch(() => ({ json: logsResp }));
    const c = makeDatadogConnector(cfg(), impl);
    const ctx = await c.fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.ap2.datadoghq.com/api/v2/logs/events/search');
    expect((calls[0]!.body as { filter: { query: string; from: string } }).filter).toMatchObject({
      query: 'service:api status:error',
      from: 'now-30m',
    });
    expect(ctx.source).toBe('datadog');
    expect((ctx.data as { errorLogs: unknown[] }).errorLogs).toEqual([
      { at: '2026-07-01T00:00:00Z', status: 'error', service: 'api', message: 'boom' },
    ]);
  });
});

describe('snapshot', () => {
  test('is unsupported for this on-demand connector', async () => {
    const c = makeDatadogConnector(cfg());
    await expect(c.snapshot()).rejects.toThrow(/does not support snapshot polling/);
  });
});

describe('probe', () => {
  const routeStatus = (validate: number, monitor: number) => (url: string) => {
    if (url.includes('/api/v1/validate')) return { ok: validate === 200, status: validate };
    if (url.includes('/api/v1/monitor/search')) return { ok: monitor === 200, status: monitor };
    return { ok: true, status: 200 };
  };

  test('healthy when both keys work', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(routeStatus(200, 200)).impl);
    const r = await c.probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
    expect(r.checks?.canRead).toBe(true);
  });

  test('unhealthy and unauthorized when the api key is invalid', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(routeStatus(403, 200)).impl);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.authorized).toBe(false);
  });

  test('unhealthy when the app key lacks read access (403)', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(routeStatus(200, 403)).impl);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.authorized).toBe(true);
    expect(r.checks?.canRead).toBe(false);
    expect(r.warnings.some((w) => /application key lacks read/.test(w))).toBe(true);
  });

  test('unhealthy when the app key read is 401 (conclusive, not transient)', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(routeStatus(200, 401)).impl);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.checks?.canRead).toBe(false);
  });

  test('stays healthy on a transient app-key read error (5xx) — a blip does not disable', async () => {
    const c = makeDatadogConnector(cfg(), fakeFetch(routeStatus(200, 500)).impl);
    const r = await c.probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
    expect(r.checks?.canRead).toBeUndefined();
    expect(r.warnings.some((w) => /could not verify application key read access/.test(w))).toBe(
      true,
    );
  });

  test('reachable:false when the api does not respond', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const c = makeDatadogConnector(cfg(), impl);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
  });

  test('unhealthy config error on an unknown site', async () => {
    const c = makeDatadogConnector(cfg({ settings: { site: 'bad' } }));
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /unknown site/.test(w))).toBe(true);
  });
});

describe('tool cancellation', () => {
  it('aborts an in-flight Datadog request when the calling investigation is cancelled', async () => {
    const { impl, signals } = abortableFetch();
    const tool = toolNamed(makeDatadogConnector(cfg(), impl), 'search');
    await expectCancelledInFlight((signal) => tool.run({ domain: 'logs' }, { signal }), signals);
  });
});
