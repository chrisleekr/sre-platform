// A real SLI ratio reader, supplied by the Prometheus connector as an optional capability. The
// reader is the only place the platform touches a metrics backend for budget math: the ratio query is
// evaluated by Prometheus and only the answer comes back, which is what lets the platform store burn
// events and never SLI samples.
//
// The read rides the existing `connect` + `ppost` path, so the SSRF guard on the base URL, the
// header-only credential, the fixed read path and the 8s timeout are inherited rather than re-invented.
import { describe, expect, test } from 'vitest';
import { makePrometheusConnector } from '../data-sources/prometheus';
import { makePrometheusSli } from '../data-sources/prometheus/sli';
import { createDataSourceConnector, type ConnectorConfig } from '../registry';
import type { HostLookup } from '../ssrf';

interface Call {
  url: string;
  method: string;
  authorization?: string;
  form?: URLSearchParams;
  redirect?: string;
  hasSignal: boolean;
}

function fakeFetch(json: unknown, ok = true, status = 200) {
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
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      authorization: headers.Authorization,
      form: init?.body ? new URLSearchParams(init.body) : undefined,
      redirect: init?.redirect,
      hasSignal: init?.signal != null,
    });
    return { ok, status, json: async () => json };
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

const vector = (samples: Array<[string, string]>) => ({
  status: 'success',
  data: {
    resultType: 'vector',
    result: samples.map(([job, value]) => ({
      metric: { job },
      value: [1700000000, value],
    })),
  },
});

const scalar = (value: string) => ({
  status: 'success',
  data: { resultType: 'scalar', result: [1700000000, value] },
});

describe('makePrometheusSli', () => {
  test('substitutes the evaluation window into the stored query and POSTs it to the instant read path', async () => {
    const { impl, calls } = fakeFetch(vector([['api', '0.0125']]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});

    const ratio = await sli.sliRatio({
      query: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
      windowSeconds: 3600,
    });

    expect(ratio).toBeCloseTo(0.0125, 9);
    expect(calls).toHaveLength(1);
    // Seconds are always a legal Prometheus duration, so the substitution never rounds a window into
    // a different one. Both placeholders are replaced, not just the first.
    expect(calls[0]!.form!.get('query')).toBe('sum(rate(errors[3600s])) / sum(rate(total[3600s]))');
    // A FIXED read path, passed as a constant. POST avoids the GET URL-length limit on long PromQL.
    expect(calls[0]!.url).toBe('https://prom.example.com/api/v1/query');
    expect(calls[0]!.method).toBe('POST');
    // The credential rides a header, never the URL; the 8s timeout and no-redirect policy are inherited.
    expect(calls[0]!.authorization).toBe('Bearer tok-1');
    expect(calls[0]!.url).not.toContain('tok-1');
    expect(calls[0]!.redirect).toBe('error');
    expect(calls[0]!.hasSignal).toBe(true);
  });

  test('a query with no window placeholder runs verbatim', async () => {
    const { impl, calls } = fakeFetch(vector([['api', '0.5']]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});

    await sli.sliRatio({ query: 'my_recorded_bad_ratio', windowSeconds: 2_592_000 });

    expect(calls[0]!.form!.get('query')).toBe('my_recorded_bad_ratio');
  });

  test('reads a scalar result', async () => {
    const { impl } = fakeFetch(scalar('0.25'));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    await expect(sli.sliRatio({ query: 'scalar(x)', windowSeconds: 3600 })).resolves.toBeCloseTo(
      0.25,
      9,
    );
  });

  test('a multi-series result throws rather than silently picking one series', async () => {
    const { impl } = fakeFetch(
      vector([
        ['api', '0.1'],
        ['worker', '0.9'],
      ]),
    );
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    // Ambiguity here would put an arbitrary service's ratio behind another service's budget.
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });

  test('an empty result throws rather than reporting a perfect zero ratio', async () => {
    const { impl } = fakeFetch(vector([]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    // A query that matched nothing is not evidence that nothing is failing.
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });

  test('a non-numeric sample throws', async () => {
    const { impl } = fakeFetch(vector([['api', 'NaN']]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });

  test('a sample above the documented range throws rather than becoming an absurd budget', async () => {
    const { impl } = fakeFetch(vector([['api', '5']]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    // An expression returning a raw count rather than a ratio is a configuration error, and reading
    // it as a ratio reports a budget overrun of millions of percent.
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });

  test('a negative sample throws rather than making the budget look better than perfect', async () => {
    const { impl } = fakeFetch(vector([['api', '-0.1']]));
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });

  test('both range boundaries are real answers and are accepted', async () => {
    // 1 is every event bad and 0 is none. Neither is malformed, so neither may be rejected.
    const all = fakeFetch(vector([['api', '1']]));
    await expect(
      makePrometheusSli(cfg(), all.impl, lookup, {}).sliRatio({
        query: 'bad_ratio',
        windowSeconds: 3600,
      }),
    ).resolves.toBe(1);

    const none = fakeFetch(vector([['api', '0']]));
    await expect(
      makePrometheusSli(cfg(), none.impl, lookup, {}).sliRatio({
        query: 'bad_ratio',
        windowSeconds: 3600,
      }),
    ).resolves.toBe(0);
  });

  test('float noise just outside a boundary clamps instead of throwing', async () => {
    const below = fakeFetch(vector([['api', '-1e-15']]));
    await expect(
      makePrometheusSli(cfg(), below.impl, lookup, {}).sliRatio({
        query: 'bad_ratio',
        windowSeconds: 3600,
      }),
    ).resolves.toBe(0);

    const above = fakeFetch(vector([['api', '1.000000000000001']]));
    await expect(
      makePrometheusSli(cfg(), above.impl, lookup, {}).sliRatio({
        query: 'bad_ratio',
        windowSeconds: 3600,
      }),
    ).resolves.toBe(1);
  });

  test('a backend error propagates instead of being read as a ratio', async () => {
    const { impl } = fakeFetch({}, false, 503);
    const sli = makePrometheusSli(cfg(), impl, lookup, {});
    await expect(sli.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 })).rejects.toThrow();
  });
});

describe('the sli capability on the connector surface', () => {
  test('the Prometheus connector declares an sli reader', async () => {
    const { impl } = fakeFetch(vector([['api', '0.02']]));
    const connector = makePrometheusConnector(cfg(), impl, lookup);

    expect(connector.sli).toBeDefined();
    await expect(
      connector.sli!.sliRatio({ query: 'bad_ratio', windowSeconds: 3600 }),
    ).resolves.toBeCloseTo(0.02, 9);
  });

  test('a connector that supplies no sli reader exposes none, so the evaluator can skip it', () => {
    // The capability is optional exactly like sourceCode: absence is the signal, not a throwing stub.
    const bare = createDataSourceConnector(
      cfg(),
      {
        type: 'prometheus',
        capabilities: {
          availability: 'ready',
          configuration: 'tenant',
          instances: 'multiple',
          investigation: 'tools',
          polling: 'none',
          events: 'authenticated',
        },
      },
      {
        probe: async () => ({
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
        }),
      },
    );
    expect(bare.sli).toBeUndefined();
  });
});
