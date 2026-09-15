import { expect, test } from 'vitest';
import { makeDatadogConnector } from '../connector';
import { datadogInventoryCollection } from '../inventory-topology';

test('non-APM discovery reads hosts and monitors independently without retaining sensitive metadata', async () => {
  const paths: string[] = [];
  const source = makeDatadogConnector(
    {
      id: 'dd',
      tenantId: 'tenant',
      type: 'datadog',
      name: 'Datadog',
      settings: { collectApm: false },
      getCredential: async () => JSON.stringify({ apiKey: 'test', appKey: 'test' }),
    },
    (async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Response.json(
        path.endsWith('/hosts')
          ? {
              host_list: [
                {
                  id: 1,
                  host_name: 'host-one',
                  tags_by_source: { user: ['service:api', 'env:production', 'secret:private'] },
                  metadata: 'private',
                },
              ],
              total_matching: 1,
            }
          : path.endsWith('/monitor')
            ? [
                {
                  id: 2,
                  name: 'API errors',
                  type: 'metric alert',
                  tags: ['service:api', 'env:production'],
                  query: 'private',
                  message: 'private',
                },
              ]
            : { data: [], meta: { count: 0 } },
      );
    }) as typeof fetch,
  );
  const result = await source.topology!.discover();
  expect(paths.some((path) => path.includes('/spans'))).toBe(false);
  expect(result.collections.map((row) => row.key)).toEqual([
    'catalog-services',
    'catalog-dependencies',
    'hosts',
    'monitors',
  ]);
  expect(result.collections.flatMap((row) => row.relations).map((row) => row.kind)).toEqual([
    'runs_on',
    'monitors',
  ]);
  expect(
    result.collections.flatMap((row) => row.entities).filter((row) => row.kind === 'service'),
  ).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain('private');
});

test('host collection pages durably without classifying ordinary batching as a scan gap', async () => {
  const offsets: number[] = [];
  const read = async (_path: string, query: Record<string, string | number>) => {
    const offset = Number(query.start);
    offsets.push(offset);
    return {
      host_list: Array.from({ length: Math.min(100, 350 - offset) }, (_, i) => ({
        id: offset + i + 1,
        host_name: `host-${offset + i}`,
      })),
      total_matching: 350,
    };
  };
  const first = await datadogInventoryCollection('dd', 'hosts', read);
  expect(first.scan).toEqual({ cursor: '3', incomplete: false });
  expect(first.completeness).toBe('partial');
  const second = await datadogInventoryCollection('dd', 'hosts', read, first.scan);
  expect(second.scan).toEqual({ cursor: null, incomplete: false });
  expect(second.completeness).toBe('complete');
  expect(offsets).toEqual([0, 100, 200, 300]);
});

test('ambiguous service or environment tags do not create service associations', async () => {
  const result = await datadogInventoryCollection('dd', 'hosts', async () => ({
    host_list: [
      { id: 1, host_name: 'shared', tags_by_source: { user: ['service:one', 'service:two'] } },
      {
        id: 2,
        host_name: 'mixed',
        tags_by_source: { user: ['service:one', 'env:prod', 'env:dev'] },
      },
    ],
    total_matching: 2,
  }));
  expect(result.entities).toHaveLength(2);
  expect(result.relations).toEqual([]);
});

test('inventory failures retain a scan gap and do not report an empty completed inventory', async () => {
  const result = await datadogInventoryCollection('dd', 'monitors', async () => {
    throw Object.assign(new Error('denied'), { status: 403 });
  });
  expect(result).toMatchObject({
    completeness: 'unavailable',
    issue: 'permission_denied',
    scan: { cursor: '0', incomplete: true },
  });
});

test('a short host page cannot falsely complete a larger inventory', async () => {
  const result = await datadogInventoryCollection('dd', 'hosts', async () => ({
    host_list: [{ id: 1, host_name: 'first' }],
    total_matching: 10,
  }));
  expect(result).toMatchObject({
    completeness: 'unavailable',
    issue: 'invalid_response',
    scan: { incomplete: true },
  });
});

test('host sightings preserve their observation age and identities stay connection scoped', async () => {
  const last = Math.floor(Date.now() / 1000) - 3600;
  const read = async () => ({
    host_list: [{ id: 1, host_name: 'same', last_reported_time: last }],
    total_matching: 1,
  });
  const first = await datadogInventoryCollection('one', 'hosts', read);
  const second = await datadogInventoryCollection('two', 'hosts', read);
  expect(first.entities[0]!.evidenceAt).toBe(new Date(last * 1000).toISOString());
  expect(first.entities[0]!.ref).not.toEqual(second.entities[0]!.ref);
});

test.each([0, 'invalid', Number.MAX_SAFE_INTEGER])(
  'invalid host observation time %s cannot become fresh evidence',
  async (last) => {
    const result = await datadogInventoryCollection('dd', 'hosts', async () => ({
      host_list: [{ id: 1, host_name: 'host', last_reported_time: last }],
      total_matching: 1,
    }));
    expect(result.entities).toEqual([]);
    expect(result).toMatchObject({
      completeness: 'partial',
      issue: 'invalid_response',
      scan: { incomplete: true },
    });
  },
);
