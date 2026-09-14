import { expect, test, vi } from 'vitest';
import { datadogLogRelations, datadogLogTopology } from '../log-topology';

const cluster = '11111111-2222-3333-4444-555555555555';
const from = '2026-09-13T00:00:00.000Z',
  at = '2026-09-13T00:01:00.000Z',
  to = '2026-09-13T00:05:00.000Z';
const access = (upstream = '10.1.2.3:8181', status = '200') =>
  `192.0.2.1 - - [13/Sep/2026:00:01:00 +0000] "GET /private?token=do-not-store HTTP/2.0" 200 20 "-" "agent" 100 0.2 [team-a-api-server-8181] [] ${upstream} 20 0.1 ${status} opaque-request`;
const event = (attributes: Record<string, unknown> = {}, message = access()) => ({
  id: 'event-1',
  attributes: {
    timestamp: at,
    service: 'controller',
    message,
    tags: [`orch_cluster_id:${cluster}`, 'kube_namespace:ingress', 'pod_name:controller-one'],
    attributes,
  },
});
test('extracts a scoped ingress call without retaining request data', () => {
  const relations = datadogLogRelations(
    event(),
    [{ clusterId: cluster, namespace: 'ingress' }],
    from,
    to,
  );
  expect(relations).toHaveLength(1);
  expect(relations[0]).toMatchObject({
    from: { kind: 'pod_name', id: '["ingress","controller-one"]' },
    to: { kind: 'tcp_address', id: '["10.1.2.3",8181]' },
    kind: 'calls',
    evidence: 'observed',
    evidenceAt: at,
    attributes: { outcome: 'response_recorded' },
  });
  expect(JSON.stringify(relations)).not.toMatch(/private|token|do-not-store|192\.0\.2/);
});

test('rejects a returned event from another namespace in the same admitted cluster', () => {
  expect(
    datadogLogRelations(event(), [{ clusterId: cluster, namespace: 'other' }], from, to),
  ).toEqual([]);
  expect(
    datadogLogRelations(event(), [{ clusterId: cluster, namespace: 'ingress' }], from, to)[0]!
      .attributes!.logQuery,
  ).toContain('kube_namespace:ingress');
});

test('deduplicates valid partial evidence before returning a later invalid response', async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce({ data: [event(), { ...event(), id: 'second' }] })
    .mockResolvedValueOnce({ data: null });
  const result = await datadogLogTopology(
    read,
    [{ clusterId: cluster, namespace: 'ingress' }],
    Date.parse(to),
  );
  expect(result.issue).toBe('invalid_response');
  expect(result.relations).toHaveLength(1);
});
test.each(['502', '503', '504', '-'])('keeps proxy %s outcomes as attempts', (status) => {
  expect(
    datadogLogRelations(
      event({}, access('10.1.2.3:8181', status)),
      [{ clusterId: cluster, namespace: 'ingress' }],
      from,
      to,
    )[0]?.attributes?.outcome,
  ).toBe('attempt_recorded');
});
test('preserves retries and IPv6 without treating every upstream as a response', () => {
  const result = datadogLogRelations(
    event({}, access('10.1.2.3:8181, [2001:db8::2]:443', '502, 200')),
    [{ clusterId: cluster, namespace: 'ingress' }],
    from,
    to,
  );
  expect(result.map((r) => r.attributes?.outcome)).toEqual([
    'attempt_recorded',
    'response_recorded',
  ]);
  expect(result[1]?.to.id).toBe('["2001:db8::2",443]');
});
test.each(['127.0.0.1:9000', '[::1]:9000', 'unix:/var/run/socket', 'bad:22', '10.1.2.3:0'])(
  'does not create a network call for %s',
  (target) => {
    expect(
      datadogLogRelations(
        event({}, access(target)),
        [{ clusterId: cluster, namespace: 'ingress' }],
        from,
        to,
      ),
    ).toEqual([]);
  },
);
test('requires unique scoped source identity and an event in the requested window', () => {
  expect(datadogLogRelations(event(), [], from, to)).toEqual([]);
  const conflicting = event();
  conflicting.attributes.tags.push('pod_name:other');
  expect(
    datadogLogRelations(conflicting, [{ clusterId: cluster, namespace: 'ingress' }], from, to),
  ).toEqual([]);
  const old = event();
  old.attributes.timestamp = '2026-09-12T00:00:00.000Z';
  expect(
    datadogLogRelations(old, [{ clusterId: cluster, namespace: 'ingress' }], from, to),
  ).toEqual([]);
});
test('server gRPC peer is the caller, and its ephemeral port is not a destination port', () => {
  const result = datadogLogRelations(
    event({ 'grpc.component': 'server', 'grpc.code': 'OK', 'peer.address': '10.2.3.4:51332' }),
    [{ clusterId: cluster, namespace: 'ingress' }],
    from,
    to,
  );
  expect(result[0]).toMatchObject({
    from: { kind: 'pod_address', id: '["10.2.3.4"]' },
    to: { kind: 'pod_name' },
  });
});
test('client gRPC completion records the callee and failures remain attempts', () => {
  const result = datadogLogRelations(
    event({
      grpc: { component: 'client', code: 'Unavailable' },
      peer: { address: '10.2.3.4:8081' },
    }),
    [{ clusterId: cluster, namespace: 'ingress' }],
    from,
    to,
  );
  expect(result[0]).toMatchObject({
    from: { kind: 'pod_name' },
    to: { kind: 'tcp_address', id: '["10.2.3.4",8081]' },
    attributes: { outcome: 'attempt_recorded' },
  });
});
test('does not convert gRPC start records or database counters into network calls', () => {
  expect(
    datadogLogRelations(
      event({ 'grpc.component': 'server', 'peer.address': '10.2.3.4:51332' }, 'started call'),
      [{ clusterId: cluster, namespace: 'ingress' }],
      from,
      to,
    ),
  ).toEqual([]);
  expect(
    datadogLogRelations(
      event({ redis_calls: 5, db_count: 2 }, 'request complete'),
      [{ clusterId: cluster, namespace: 'ingress' }],
      from,
      to,
    ),
  ).toEqual([]);
});
test('samples three schemas with one frozen window and deduplicates repeated events', async () => {
  const read = vi.fn(async (_body: Record<string, unknown>) => ({
    data: [event(), event()],
    meta: { page: { after: 'private-cursor' } },
  }));
  const result = await datadogLogTopology(
    read,
    [{ clusterId: cluster, namespace: 'ingress' }],
    Date.parse(to),
  );
  expect(read).toHaveBeenCalledTimes(3);
  expect(result.relations).toHaveLength(1);
  expect(result).toMatchObject({ completeness: 'partial', issue: 'limit' });
  const bodies = read.mock.calls.map((args) => args[0]) as Array<{
    filter: { from: string; to: string; query: string };
  }>;
  expect(new Set(bodies.map((body) => body.filter.from)).size).toBe(1);
  expect(bodies.every((body) => body.filter.query.includes(cluster))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private-cursor');
});
test('does not query logs without verified cluster scope', async () => {
  const read = vi.fn();
  expect(await datadogLogTopology(read, [])).toMatchObject({ issue: 'missing_scope' });
  expect(read).not.toHaveBeenCalled();
});
test('stops on rate limiting without retrying or exposing the provider error', async () => {
  const read = vi
    .fn()
    .mockRejectedValue(Object.assign(new Error('secret payload'), { status: 429 }));
  expect(
    await datadogLogTopology(read, [{ clusterId: cluster, namespace: 'ingress' }]),
  ).toMatchObject({
    completeness: 'unavailable',
    issue: 'rate_limited',
  });
  expect(read).toHaveBeenCalledTimes(1);
});
test('distinguishes empty data from unsupported log schemas', async () => {
  expect(
    await datadogLogTopology(
      async () => ({ data: [] }),
      [{ clusterId: cluster, namespace: 'ingress' }],
      Date.parse(to),
    ),
  ).toMatchObject({ issue: 'no_matches' });
  expect(
    await datadogLogTopology(
      async () => ({ data: [event({}, 'not a request')] }),
      [{ clusterId: cluster, namespace: 'ingress' }],
      Date.parse(to),
    ),
  ).toMatchObject({ issue: 'unsupported_schema' });
});
