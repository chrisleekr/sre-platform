import { describe, expect, it, test } from 'vitest';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import type { ConnectorTool } from '../../../types';
import { buildGetUrl, makeGrafanaConnector } from '../index';
import { abortableFetch, expectCancelledInFlight } from '../../../__tests__/request-signal.fixture';

interface Call {
  url: string;
  method: string;
  authorization?: string;
  accept?: string;
  redirect?: string;
  tls?: { ca?: string; rejectUnauthorized?: boolean };
  hasSignal: boolean;
}

interface Resp {
  ok?: boolean;
  status?: number;
  json?: unknown;
}

/** A fake fetch; records auth header, tls, and safety options per call, and serves json. */
function fakeFetch(handler?: (url: string) => Resp) {
  const calls: Call[] = [];
  const impl = (async (
    url: string,
    init?: {
      method?: string;
      headers?: Record<string, string>;
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
      accept: headers.Accept,
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

const BASE = 'https://grafana.example.com';

function cfg(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    tenantId: 't1',
    type: 'grafana',
    settings: { baseUrl: BASE },
    getCredential: async () => 'sa-token',
    ...overrides,
    id: overrides.id ?? '00000000-0000-4000-8000-000000000001',
    name: overrides.name ?? 'Test Grafana',
  };
}

function conn(
  fetchImpl: ReturnType<typeof fakeFetch>['impl'],
  overrides: Partial<ConnectorConfig> = {},
) {
  return makeGrafanaConnector(cfg(overrides), fetchImpl, lookup);
}

function toolNamed(c: ReturnType<typeof makeGrafanaConnector>, name: string): ConnectorTool {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('makeGrafanaConnector tool set', () => {
  test('declares the 8 tools in order', () => {
    const c = makeGrafanaConnector(cfg(), fakeFetch().impl, lookup);
    expect(c.tools().map((t) => t.name)).toEqual([
      'list_alert_rules',
      'list_firing_alerts',
      'get_alert_rule',
      'search_dashboards',
      'get_dashboard',
      'list_annotations',
      'list_datasources',
      'api_get',
    ]);
  });
});

describe('buildGetUrl', () => {
  it('builds an absolute url under /api/ and encodes query', () => {
    expect(buildGetUrl(BASE, 'api/search', { query: 'a b' })).toBe(
      'https://grafana.example.com/api/search?query=a+b',
    );
  });
  it('appends array query values (repeated params)', () => {
    const u = new URL(
      buildGetUrl(BASE, 'api/alertmanager/grafana/api/v2/alerts', { filter: ['a=1', 'b=2'] }),
    );
    expect(u.searchParams.getAll('filter')).toEqual(['a=1', 'b=2']);
  });
  it('validates against a path-prefixed base (reverse proxy)', () => {
    expect(buildGetUrl('https://host.example.com/grafana', 'api/org')).toBe(
      'https://host.example.com/grafana/api/org',
    );
  });
  it('rejects a path escaping the host', () => {
    expect(() => buildGetUrl(BASE, 'https://evil.example.com/api/org')).toThrow(
      /escapes the configured host/,
    );
  });
  it('rejects a path outside /api/ via traversal', () => {
    expect(() => buildGetUrl(BASE, 'api/../secret')).toThrow(/must be under \/api\//);
  });
  it('rejects a percent-encoded pathname (encoded-denylist bypass)', () => {
    expect(() => buildGetUrl(BASE, 'api/datasources/%70roxy/uid/x')).toThrow(
      /percent-encoded path segments/,
    );
  });
  it('neutralizes a protocol-relative path (stripped on-host, then refused as outside /api/)', () => {
    // leading slashes stripped → resolves to /evil.com/... on the configured host, not an external host,
    // and is then refused by the /api/ prefix guard. Never reaches evil.com.
    expect(() => buildGetUrl(BASE, '//evil.com/api/org')).toThrow(/must be under \/api\//);
  });
});

describe('auth + transport', () => {
  test('sends the token as Bearer, no-redirect, with a timeout signal', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl), 'list_datasources').run({});
    expect(calls[0]!.authorization).toBe('Bearer sa-token');
    expect(calls[0]!.accept).toBe('application/json');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('trims the stored token', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(conn(impl, { getCredential: async () => '  tok-2\n' }), 'list_datasources').run(
      {},
    );
    expect(calls[0]!.authorization).toBe('Bearer tok-2');
  });

  test('rejects an empty credential', async () => {
    const c = conn(fakeFetch().impl, { getCredential: async () => '   ' });
    await expect(toolNamed(c, 'list_datasources').run({})).rejects.toThrow(
      /service-account token.*required/,
    );
  });

  test('passes a pinned CA / insecure flag through as tls (self-hosted trust)', async () => {
    const { impl, calls } = fakeFetch();
    await toolNamed(
      conn(impl, { settings: { baseUrl: BASE, caCert: 'CA-PEM', insecureSkipTLSVerify: true } }),
      'list_datasources',
    ).run({});
    expect(calls[0]!.tls).toEqual({ ca: 'CA-PEM', rejectUnauthorized: false });
  });

  test('rejects a missing baseUrl', async () => {
    const c = conn(fakeFetch().impl, { settings: {} });
    await expect(toolNamed(c, 'list_datasources').run({})).rejects.toThrow(/baseUrl is required/);
  });

  test('accepts an HTTP baseUrl', async () => {
    const { impl, calls } = fakeFetch();
    const c = conn(impl, { settings: { baseUrl: 'http://grafana.example.com' } });
    await toolNamed(c, 'list_datasources').run({});
    expect(calls[0]!.url).toBe('http://grafana.example.com/api/datasources');
  });

  test('keeps loopback blocked unless the development option is explicit', async () => {
    const blocked = conn(fakeFetch().impl, { settings: { baseUrl: 'http://127.0.0.1:3000' } });
    await expect(toolNamed(blocked, 'list_datasources').run({})).rejects.toThrow(/not allowed/);

    const { impl, calls } = fakeFetch();
    const allowed = makeGrafanaConnector(
      cfg({ settings: { baseUrl: 'http://127.0.0.1:3000' } }),
      impl,
      lookup,
      { allowedLoopbackOrigins: ['http://127.0.0.1:3000'] },
    );
    await toolNamed(allowed, 'list_datasources').run({});
    expect(calls[0]!.url).toBe('http://127.0.0.1:3000/api/datasources');
  });
});

describe('alerting tools', () => {
  test('list_alert_rules defaults to the grafana datasource', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: { status: 'success', data: {} } }));
    await toolNamed(conn(impl), 'list_alert_rules').run({});
    expect(new URL(calls[0]!.url).pathname).toBe('/api/prometheus/grafana/api/v1/rules');
  });

  test('list_alert_rules honors an external datasourceUid', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'list_alert_rules').run({ datasourceUid: 'abc-123_x' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/prometheus/abc-123_x/api/v1/rules');
  });

  test('list_alert_rules rejects an invalid datasourceUid before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'list_alert_rules').run({ datasourceUid: '../secret' }),
    ).rejects.toThrow(/invalid datasourceUid/);
    expect(calls).toHaveLength(0);
  });

  test('list_firing_alerts hits the AM v2 alerts path with filter + booleans', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_firing_alerts').run({
      filter: ['service=api', 'severity=critical'],
      active: true,
      silenced: false,
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/alertmanager/grafana/api/v2/alerts');
    expect(u.searchParams.getAll('filter')).toEqual(['service=api', 'severity=critical']);
    expect(u.searchParams.get('active')).toBe('true');
    expect(u.searchParams.get('silenced')).toBe('false');
  });

  test('get_alert_rule hits the provisioning path and validates the uid', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'get_alert_rule').run({ uid: 'rule-uid-1' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/v1/provisioning/alert-rules/rule-uid-1');
  });

  test('get_alert_rule rejects an invalid uid before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(toolNamed(conn(impl), 'get_alert_rule').run({ uid: 'a/b' })).rejects.toThrow(
      /invalid uid/,
    );
    expect(calls).toHaveLength(0);
  });

  test('list_firing_alerts defaults to paging-only (active, not silenced, not inhibited)', async () => {
    // AM v2 defaults all three to true; the tool must send active=true&silenced=false&inhibited=false
    // for a no-arg call so muted alerts are not surfaced as paging.
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_firing_alerts').run({});
    const u = new URL(calls[0]!.url);
    expect(u.searchParams.get('active')).toBe('true');
    expect(u.searchParams.get('silenced')).toBe('false');
    expect(u.searchParams.get('inhibited')).toBe('false');
  });

  test('list_firing_alerts honors an explicit silenced=true opt-in', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_firing_alerts').run({ silenced: true });
    expect(new URL(calls[0]!.url).searchParams.get('silenced')).toBe('true');
  });
});

describe('dashboard tools', () => {
  test('search_dashboards passes query/tag/type and clamps limit', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'search_dashboards').run({
      query: 'checkout',
      tag: ['prod', 'payments'],
      type: 'dash-db',
      limit: 9000,
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/search');
    expect(u.searchParams.get('query')).toBe('checkout');
    expect(u.searchParams.getAll('tag')).toEqual(['prod', 'payments']);
    expect(u.searchParams.get('type')).toBe('dash-db');
    expect(u.searchParams.get('limit')).toBe('1000'); // clamped to MAX_LIMIT
  });

  test('search_dashboards rejects an invalid type via schema', () => {
    const tool = toolNamed(conn(fakeFetch().impl), 'search_dashboards');
    expect(tool.inputSchema.safeParse({ type: 'alert-rule' }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ type: 'dash-folder' }).success).toBe(true);
  });

  test('get_dashboard hits /api/dashboards/uid/{uid} and validates the uid', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'get_dashboard').run({ uid: 'abcXYZ_-9' });
    expect(new URL(calls[0]!.url).pathname).toBe('/api/dashboards/uid/abcXYZ_-9');
  });

  test('get_dashboard rejects an invalid uid before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(toolNamed(conn(impl), 'get_dashboard').run({ uid: '../../etc' })).rejects.toThrow(
      /invalid uid/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('list_annotations', () => {
  test('resolves an absolute ISO from/to to epoch-ms and passes tags/type/limit', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    const from = '2026-01-01T00:00:00.000Z';
    const to = '2026-01-01T01:00:00.000Z';
    await toolNamed(conn(impl), 'list_annotations').run({
      from,
      to,
      tags: ['deploy'],
      type: 'annotation',
    });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/annotations');
    expect(u.searchParams.get('from')).toBe(String(Date.parse(from)));
    expect(u.searchParams.get('to')).toBe(String(Date.parse(to)));
    expect(u.searchParams.getAll('tags')).toEqual(['deploy']);
    expect(u.searchParams.get('type')).toBe('annotation');
    expect(u.searchParams.get('limit')).toBe('100'); // DEFAULT_LIMIT
  });

  test('resolves a relative from to a numeric epoch-ms', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    const before = Date.now();
    await toolNamed(conn(impl), 'list_annotations').run({ from: 'now-1h' });
    const fromMs = Number(new URL(calls[0]!.url).searchParams.get('from'));
    // now-1h is one hour before now; bracket it against wall-clock at call time.
    expect(fromMs).toBeGreaterThanOrEqual(before - 3_600_000 - 5_000);
    expect(fromMs).toBeLessThanOrEqual(before - 3_600_000 + 5_000);
  });

  test('rejects an invalid dashboardUID before any fetch', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'list_annotations').run({ dashboardUID: 'a b' }),
    ).rejects.toThrow(/invalid dashboardUID/);
    expect(calls).toHaveLength(0);
  });

  test('treats a bare epoch-seconds from as seconds (scaled to ms)', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_annotations').run({ from: '1735689600' });
    expect(new URL(calls[0]!.url).searchParams.get('from')).toBe('1735689600000');
  });

  test('treats a bare epoch-millis from as millis (left as-is)', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_annotations').run({ from: '1735689600000' });
    expect(new URL(calls[0]!.url).searchParams.get('from')).toBe('1735689600000');
  });

  test('rejects an unparseable time', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'list_annotations').run({ from: 'yesterday' }),
    ).rejects.toThrow(/unparseable time/);
    expect(calls).toHaveLength(0);
  });
});

describe('list_datasources', () => {
  test('hits /api/datasources', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: [] }));
    await toolNamed(conn(impl), 'list_datasources').run({});
    expect(new URL(calls[0]!.url).pathname).toBe('/api/datasources');
  });
});

describe('api_get', () => {
  test('GETs an arbitrary /api path with query', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/folders', query: { limit: 10 } });
    expect(calls[0]!.url).toBe('https://grafana.example.com/api/folders?limit=10');
    expect(calls[0]!.method).toBe('GET');
  });

  test('allows the plain datasources list and a single datasource', async () => {
    const { impl, calls } = fakeFetch(() => ({ json: {} }));
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/datasources' });
    await toolNamed(conn(impl), 'api_get').run({ path: 'api/datasources/uid/abc' });
    expect(calls).toHaveLength(2);
  });

  test('refuses the datasource proxy tunnel', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/datasources/proxy/uid/x/api/v1/query' }),
    ).rejects.toThrow(/proxy\/resources paths are not permitted/);
    expect(calls).toHaveLength(0);
  });

  test('refuses the datasource resources tunnel', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/datasources/uid/abc/resources/foo' }),
    ).rejects.toThrow(/proxy\/resources paths are not permitted/);
    expect(calls).toHaveLength(0);
  });

  test('rejects a percent-encoded proxy-bypass attempt (buildGetUrl guard)', async () => {
    const { impl, calls } = fakeFetch();
    await expect(
      toolNamed(conn(impl), 'api_get').run({ path: 'api/datasources/%70roxy/uid/x' }),
    ).rejects.toThrow(/percent-encoded path segments/);
    expect(calls).toHaveLength(0);
  });

  test('rejects a traversal path', async () => {
    const c = conn(fakeFetch().impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/../secret' })).rejects.toThrow(
      /must be under \/api\//,
    );
  });

  test('throws on a non-ok status', async () => {
    const c = conn(fakeFetch(() => ({ ok: false, status: 404 })).impl);
    await expect(toolNamed(c, 'api_get').run({ path: 'api/org' })).rejects.toThrow(
      /grafana api 404/,
    );
  });
});

describe('fetchTriageContext', () => {
  const alertsResp = [
    { labels: { alertname: 'HighLatency', service: 'api' }, status: { state: 'active' } },
    { labels: { alertname: 'DiskFull', service: 'db' }, status: { state: 'active' } },
    { labels: { alertname: 'CertExpiry', job: 'api' }, status: { state: 'active' } },
  ];

  test('seeds firing alerts scoped to the service and carries the mapped fields', async () => {
    const resp = [
      {
        labels: { alertname: 'HighLatency', service: 'api', severity: 'critical' },
        annotations: { summary: 'p99 up' },
        status: { state: 'active' },
        startsAt: '2026-01-01T00:00:00Z',
      },
      { labels: { alertname: 'DiskFull', service: 'db' }, status: { state: 'active' } },
      { labels: { alertname: 'CertExpiry', job: 'api' }, status: { state: 'active' } },
    ];
    const { impl, calls } = fakeFetch(() => ({ json: resp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe('/api/alertmanager/grafana/api/v2/alerts');
    expect(u.searchParams.get('active')).toBe('true');
    expect(ctx.source).toBe('grafana');
    expect((ctx.data as { windowMinutes: number }).windowMinutes).toBe(30);
    const firing = (
      ctx.data as {
        firingAlerts: Array<{ alertname?: string; severity?: string; startsAt?: string }>;
      }
    ).firingAlerts;
    expect(firing.map((a) => a.alertname).sort()).toEqual(['CertExpiry', 'HighLatency']);
    const hi = firing.find((a) => a.alertname === 'HighLatency')!;
    expect(hi.severity).toBe('critical');
    expect(hi.startsAt).toBe('2026-01-01T00:00:00Z');
  });

  test('falls back to all firing alerts when none match the service', async () => {
    const { impl } = fakeFetch(() => ({ json: alertsResp }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'nomatch', windowMinutes: 30 });
    expect((ctx.data as { firingAlerts: unknown[] }).firingAlerts).toHaveLength(3);
  });

  test('caps the first-pass seed at TRIAGE_ALERT_CAP (25)', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      labels: { alertname: `A${i}`, service: 'api' },
      status: { state: 'active' },
    }));
    const { impl } = fakeFetch(() => ({ json: many }));
    const ctx = await conn(impl).fetchTriageContext({ service: 'api', windowMinutes: 30 });
    expect((ctx.data as { firingAlerts: unknown[] }).firingAlerts).toHaveLength(25);
  });

  test('degrades to a note on error, never throws', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const ctx = await makeGrafanaConnector(cfg(), impl, lookup).fetchTriageContext({
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
  test('uses GET /api/org', async () => {
    const { impl, calls } = fakeFetch(() => ({ status: 200 }));
    await conn(impl).probe();
    expect(new URL(calls[0]!.url).pathname).toBe('/api/org');
  });

  test('healthy when /api/org returns 200', async () => {
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

  test('unhealthy and unauthorized on 403 (token lacks org read)', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 403 })).impl).probe();
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
    expect(r.warnings).toContain('grafana redirected the API request to an authentication gateway');
    expect(provider.calls[0]!.redirect).toBe('manual');
  });

  test('unhealthy on a 5xx', async () => {
    const r = await conn(fakeFetch(() => ({ ok: false, status: 503 })).impl).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.warnings.some((w) => /returned 503/.test(w))).toBe(true);
  });

  test('reachable:false when grafana does not respond', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const r = await makeGrafanaConnector(cfg(), impl, lookup).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /did not respond/.test(w))).toBe(true);
  });

  test('unhealthy config error when the credential is empty', async () => {
    const r = await conn(fakeFetch().impl, { getCredential: async () => '' }).probe();
    expect(r.status).toBe('unhealthy');
    expect(r.reachable).toBe(false);
    expect(r.warnings.some((w) => /service-account token.*required/.test(w))).toBe(true);
  });
});

describe('tool cancellation', () => {
  it('aborts an in-flight Grafana request when the calling investigation is cancelled', async () => {
    const { impl, signals } = abortableFetch();
    const tool = toolNamed(conn(impl), 'list_datasources');
    await expectCancelledInFlight((signal) => tool.run({}, { signal }), signals);
  });
});
