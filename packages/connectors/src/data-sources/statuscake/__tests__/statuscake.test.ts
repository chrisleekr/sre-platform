import { describe, expect, it, test } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { ConnectorTool } from '../../../types';
import { buildGetUrl, makeStatusCakeConnector } from '../connector';

interface Call {
  url: string;
  method: string;
  authorization?: string;
  accept?: string;
  redirect?: string;
  hasSignal: boolean;
}

interface Resp {
  ok?: boolean;
  status?: number;
  json?: unknown;
}

/** A fake fetch; records auth header and safety options per call, and serves json. */
function fakeFetch(handler?: (url: string) => Resp) {
  const calls: Call[] = [];
  const impl = (async (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
      signal?: unknown;
      redirect?: string;
    },
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.Authorization,
      accept: headers.Accept,
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
    type: 'statuscake',
    settings: {},
    getCredential: async () => 'sc-token',
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test StatusCake',
  };
}

function conn(
  fetchImpl: ReturnType<typeof fakeFetch>['impl'],
  overrides: Partial<ConnectorConfig> = {},
) {
  return makeStatusCakeConnector(cfg(overrides), fetchImpl);
}

function toolNamed(c: ReturnType<typeof makeStatusCakeConnector>, name: string): ConnectorTool {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('makeStatusCakeConnector tool set', () => {
  test('declares the 8 tools in order', () => {
    const c = makeStatusCakeConnector(cfg(), fakeFetch().impl);
    expect(c.tools().map((t) => t.name)).toEqual([
      'list_tests',
      'get_test',
      'get_test_history',
      'get_uptime_periods',
      'get_uptime_alerts',
      'list_maintenance_windows',
      'list_contact_groups',
      'api_get',
    ]);
  });
});

describe('buildGetUrl', () => {
  it('builds an absolute url under /v1 and encodes query', () => {
    expect(buildGetUrl('v1/uptime', { tags: 'a,b' })).toBe(
      'https://api.statuscake.com/v1/uptime?tags=a%2Cb',
    );
  });
  it('rejects a path escaping the host', () => {
    expect(() => buildGetUrl('https://evil.example.com/v1/uptime')).toThrow(
      /escapes the configured host/,
    );
  });
  it('rejects a path outside /v1 via traversal', () => {
    expect(() => buildGetUrl('v1/../secret')).toThrow(/must be under \/v1\//);
  });
  it('neutralizes a protocol-relative path (stripped on-host, then refused as outside /v1)', () => {
    // leading slashes stripped → resolves to /evil.com/... on the pinned host, not an external host,
    // and is then refused by the /v1/ prefix guard. Never reaches evil.com.
    expect(() => buildGetUrl('//evil.com/v1/uptime')).toThrow(/must be under \/v1\//);
  });
});

describe('auth + transport', () => {
  test('sends the token as Bearer, no-redirect, with a timeout signal', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'list_contact_groups').run({});
    expect(calls[0]!.authorization).toBe('Bearer sc-token');
    expect(calls[0]!.accept).toBe('application/json');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('trims the stored token', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(
      conn(impl, { getCredential: async () => '  tok-2\n' }),
      'list_contact_groups',
    ).run({});
    expect(calls[0]!.authorization).toBe('Bearer tok-2');
  });

  test('rejects an empty credential', async () => {
    const c = conn(fakeFetch().impl, { getCredential: async () => '   ' });
    await expect(toolNamed(c, 'list_contact_groups').run({})).rejects.toThrow(
      /API token.*required/,
    );
  });
});

describe('list_tests', () => {
  test('hits /v1/{type} with tags, matchany, and clamped pagination', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { data: [], metadata: {} } }));
    await toolNamed(conn(impl), 'list_tests').run({
      type: 'uptime',
      tags: 'prod',
      matchany: true,
      per_page: 500,
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v1/uptime');
    expect(u.searchParams.get('tags')).toBe('prod');
    expect(u.searchParams.get('matchany')).toBe('true');
    expect(u.searchParams.get('per_page')).toBe('100'); // clamped to MAX_PER_PAGE
  });

  test('defaults per_page to 25', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'list_tests').run({ type: 'ssl' });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v1/ssl');
    expect(u.searchParams.get('per_page')).toBe('25');
  });

  test('per_page lower bound is 1', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'list_tests').run({ type: 'heartbeat', per_page: 0 });
    expect(new URL(calls[0]!.url).searchParams.get('per_page')).toBe('1');
  });
});

describe('get_test + get_test_history', () => {
  test('get_test hits /v1/{type}/{id}', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { data: {} } }));
    await toolNamed(conn(impl), 'get_test').run({ type: 'ssl', id: '12345' });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/ssl/12345');
  });

  test('get_test_history hits /v1/{type}/{id}/history', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'get_test_history').run({ type: 'pagespeed', id: '99' });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/pagespeed/99/history');
  });

  test('get_test_history schema excludes ssl and heartbeat (no history endpoint)', () => {
    const tool = toolNamed(conn(fakeFetch().impl), 'get_test_history');
    expect(tool.inputSchema.safeParse({ type: 'ssl', id: '1' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ type: 'heartbeat', id: '1' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ type: 'uptime', id: '1' }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ type: 'pagespeed', id: '1' }).success).toBe(true);
  });

  test('rejects an invalid id before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'get_test').run({ type: 'uptime', id: '../secret' }),
    ).rejects.toThrow(/invalid id/);
    expect(calls).toHaveLength(0);
  });
});

describe('uptime sub-resources', () => {
  test('get_uptime_periods hits /v1/uptime/{id}/periods', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'get_uptime_periods').run({ id: '77' });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/uptime/77/periods');
  });

  test('get_uptime_alerts hits /v1/uptime/{id}/alerts', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'get_uptime_alerts').run({ id: '77' });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/uptime/77/alerts');
  });
});

describe('list_maintenance_windows / list_contact_groups', () => {
  test.each([
    ['list_maintenance_windows', '/v1/maintenance-windows'],
    ['list_contact_groups', '/v1/contact-groups'],
  ])('%s hits %s', async (name, path) => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), name).run({});
    expect(new URL(calls[0]!.url).pathname).toBe(path);
  });
});

describe('api_get', () => {
  test('GETs an arbitrary /v1 path with query', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'api_get').run({ path: 'v1/ssl/42', query: { foo: 'bar' } });
    expect(calls[0]!.url).toBe('https://api.statuscake.com/v1/ssl/42?foo=bar');
    expect(calls[0]!.method).toBe('GET');
  });

  test('rejects a traversal path', async () => {
    const c = conn(fakeFetch().impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'v1/../secret' })).rejects.toThrow(
      /must be under \/v1\//,
    );
  });

  test('throws on a non-ok status', async () => {
    const c = conn(fakeFetch(() => ({ ok: false, status: 404 })).impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'v1/uptime' })).rejects.toThrow(
      /statuscake api 404/,
    );
  });
});

describe('fetchTriageContext', () => {
  const uptimeResp = {
    data: [
      {
        id: 1,
        name: 'api prod',
        website_url: 'https://api.example.com',
        status: 'down',
        tags: ['api'],
      },
      { id: 2, name: 'web', website_url: 'https://web.example.com', status: 'up' },
      {
        id: 3,
        name: 'other',
        website_url: 'https://other.example.com',
        status: 'down',
        tags: ['x'],
      },
    ],
  };

  test('seeds down tests scoped to the service', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: uptimeResp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect(new URL(calls[0]!.url).pathname).toBe('/v1/uptime');
    expect(ctx.source).toBe('statuscake');
    const down = (ctx.data as { downTests: Array<{ name?: string }> }).downTests;
    expect(down).toHaveLength(1);
    expect(down[0]!.name).toBe('api prod');
  });

  test('falls back to all down tests when none match the service', async () => {
    const { impl } = fakeFetch(() => ({ json: uptimeResp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'nomatch', windowMinutes: 30 });
    expect((ctx.data as { downTests: unknown[] }).downTests).toHaveLength(2);
  });

  test('treats a mixed-case status as down (case-insensitive)', async () => {
    const resp = { data: [{ id: 9, name: 'api cache', status: 'Down', tags: ['api'] }] };
    const { impl } = fakeFetch(() => ({ json: resp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect((ctx.data as { downTests: unknown[] }).downTests).toHaveLength(1);
  });

  test('scopes by tag when name and url do not contain the service', async () => {
    const resp = {
      data: [
        {
          id: 10,
          name: 'checkout',
          website_url: 'https://shop.example.com',
          status: 'down',
          tags: ['payments'],
        },
        {
          id: 11,
          name: 'blog',
          website_url: 'https://blog.example.com',
          status: 'down',
          tags: ['content'],
        },
      ],
    };
    const { impl } = fakeFetch(() => ({ json: resp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'payments', windowMinutes: 30 });
    const down = (ctx.data as { downTests: Array<{ name?: string }> }).downTests;
    expect(down).toHaveLength(1);
    expect(down[0]!.name).toBe('checkout');
  });

  test('degrades to a note on error, never throws', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const ctx = await makeStatusCakeConnector(cfg(), impl).fetchTriageContext({
      service: 'api',
      windowMinutes: 30,
    });
    expect((ctx.data as { note?: string }).note).toMatch(/first-pass unavailable/);
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
  test('healthy when the uptime list returns 200', async () => {
    const r = await conn(fakeFetch(() => ({ ok: true, status: 200 })).impl).probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
  });

  test('uses a per_page=1 uptime probe', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    await conn(impl).probe();
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/v1/uptime');
    expect(u.searchParams.get('per_page')).toBe('1');
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

  test('reachable:false when statuscake does not respond', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await makeStatusCakeConnector(cfg(), impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /did not respond/.test(w))).toBe(true);
  });

  test('unhealthy config error when the credential is empty', async () => {
    const r = await conn(fakeFetch().impl, { getCredential: async () => '' }).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /API token.*required/.test(w))).toBe(true);
  });
});
