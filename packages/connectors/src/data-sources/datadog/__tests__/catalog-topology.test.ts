import { expect, test } from 'vitest';
import { makeDatadogConnector } from '../connector';
import type { ConnectorConfig } from '../../../registry';

const config: ConnectorConfig = {
  id: 'dd-one',
  tenantId: 'tenant',
  name: 'Datadog',
  type: 'datadog',
  settings: { site: 'ap2.datadoghq.com' },
  getCredential: async () => JSON.stringify({ apiKey: 'secret-api', appKey: 'secret-app' }),
};
const entity = (id: string, name: string, env = 'production') => ({
  id,
  attributes: {
    kind: 'service',
    name,
    namespace: 'payments-domain',
    tags: [`env:${env}`, 'token:do-not-retain'],
    owner: 'private-contact',
    description: 'do-not-retain',
  },
  relationships: {},
});
const dependency = {
  id: 'dep-one',
  attributes: {
    type: 'RelationTypeDependsOn',
    from: { kind: 'service', namespace: 'payments-domain', name: 'checkout' },
    to: { kind: 'service', namespace: 'payments-domain', name: 'payments' },
  },
  relationships: {
    fromEntity: { data: { id: 'checkout-id' } },
    toEntity: { data: { id: 'payments-id' } },
  },
};
const response = (data: unknown[], count = data.length) => ({ data, meta: { count } });
function source(handler: (url: URL) => unknown | Response) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const connector = makeDatadogConnector(config, (async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const result = handler(url);
    return result instanceof Response ? result : Response.json(result);
  }) as typeof fetch);
  return { connector, calls };
}

test('collects scoped catalog declarations even when span indexing rejects the query', async () => {
  const { connector, calls } = source((url) =>
    url.pathname.endsWith('/search')
      ? new Response(null, { status: 400 })
      : url.pathname.endsWith('/entity')
        ? response([
            entity('checkout-id', 'checkout'),
            entity('payments-id', 'payments'),
            entity('staging-id', 'checkout', 'staging'),
          ])
        : response([dependency]),
  );
  const result = await connector.topology!.discover();
  expect(result.collections[0]).toMatchObject({
    key: 'apm',
    completeness: 'unavailable',
    issue: 'request_rejected',
  });
  expect(result.collections[1]).toMatchObject({
    key: 'catalog-services',
    completeness: 'complete',
    scan: { cursor: null },
  });
  expect(result.collections[1]!.entities).toHaveLength(3);
  expect(result.collections[1]!.entities[0]).toMatchObject({
    ref: { authority: 'connector:dd-one', kind: 'catalog-service', id: 'checkout-id' },
    scope: { catalogNamespace: 'payments-domain', environment: 'production' },
    aliases: [{ kind: 'catalog-reference' }],
  });
  expect(result.collections[2]!.relations[0]).toMatchObject({
    kind: 'depends_on',
    evidence: 'declared',
    from: { id: 'checkout-id' },
    to: { id: 'payments-id' },
  });
  expect(JSON.stringify(result)).not.toMatch(/do-not-retain|private-contact|secret-api|secret-app/);
  for (const call of calls) {
    expect(call.url.origin).toBe('https://api.ap2.datadoghq.com');
    expect(call.init?.redirect).toBe('error');
    expect(new Headers(call.init?.headers).get('DD-APPLICATION-KEY')).toBe('secret-app');
  }
  expect(calls[1]!.url.searchParams.get('includeDiscovered')).toBe('true');
  expect(calls[2]!.url.searchParams.get('includeDiscovered')).toBe('false');
  expect(calls[2]!.url.searchParams.get('filter[type]')).toBe('RelationTypeDependsOn');
});

test('does not let catalog permission failure invalidate independent span evidence', async () => {
  const { connector } = source((url) =>
    url.pathname.endsWith('/search') ? { data: [] } : new Response(null, { status: 403 }),
  );
  const result = await connector.topology!.discover();
  expect(result.collections[0]).toMatchObject({
    key: 'apm',
    completeness: 'partial',
    issue: 'sampling',
  });
  expect(
    result.collections.slice(1).every((collection) => collection.issue === 'permission_denied'),
  ).toBe(true);
});

test('does not issue further account reads after a rate limit', async () => {
  const { connector, calls } = source(() => new Response(null, { status: 429 }));
  const result = await connector.topology!.discover();
  expect(calls).toHaveLength(1);
  expect(result.collections.every((collection) => collection.issue === 'rate_limited')).toBe(true);
});

test('continues a bounded inventory scan without trusting provider next-link destinations', async () => {
  const { connector, calls } = source((url) => {
    if (!url.pathname.endsWith('/entity')) return response([]);
    const offset = Number(url.searchParams.get('page[offset]'));
    return {
      ...response(
        Array.from({ length: Math.min(100, 320 - offset) }, (_, i) =>
          entity(String(offset + i), `service-${offset + i}`),
        ),
        320,
      ),
      links: { next: 'https://untrusted.example/steal-keys' },
    };
  });
  const first = await connector.topology!.discover();
  expect(first.collections[1]).toMatchObject({
    completeness: 'partial',
    issue: 'limit',
    scan: { cursor: '300', incomplete: false },
  });
  expect(first.collections[1]!.entities).toHaveLength(300);
  const last = await connector.topology!.discover({
    scans: { 'catalog-services': first.collections[1]!.scan! },
  });
  expect(last.collections[1]).toMatchObject({ completeness: 'complete', scan: { cursor: null } });
  expect(last.collections[1]!.entities).toHaveLength(20);
  expect(calls.every((call) => call.url.hostname === 'api.ap2.datadoghq.com')).toBe(true);
});

test('rejects malformed inventory and preserves explicit catalog references without APM aliases', async () => {
  const missingId = entity('', 'invalid');
  const item = entity('global-id', 'checkout');
  item.attributes.tags = ['env:production', 'env:staging'];
  const { connector } = source((url) =>
    url.pathname.endsWith('/search')
      ? { data: [] }
      : url.pathname.endsWith('/entity')
        ? response([missingId, item])
        : response([{ ...dependency, relationships: {} }]),
  );
  const result = await connector.topology!.discover();
  expect(result.collections[1]).toMatchObject({
    completeness: 'partial',
    issue: 'invalid_response',
  });
  const global = result.collections[1]!.entities[0]!;
  expect(global.scope.environment).toBeUndefined();
  expect(global.attributes.environmentScope).toBe('Multiple declared environments');
  expect(global.aliases?.every((alias) => alias.kind === 'catalog-reference')).toBe(true);
  expect(result.collections[2]!.relations[0]?.from).toMatchObject({ kind: 'catalog-reference' });
});

test('does not mark malformed pagination or empty nonterminal pages complete', async () => {
  for (const page of [{ data: [] }, response([], 5)]) {
    const { connector } = source((url) => (url.pathname.endsWith('/search') ? { data: [] } : page));
    const result = await connector.topology!.discover();
    expect(
      result.collections
        .filter((collection) => collection.key.startsWith('catalog-'))
        .every(
          (collection) =>
            collection.issue === 'invalid_response' && collection.completeness === 'partial',
        ),
    ).toBe(true);
  }
});
