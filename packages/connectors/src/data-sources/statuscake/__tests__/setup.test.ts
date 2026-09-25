import { describe, expect, test } from 'vitest';
import {
  redactStatusCakeSecrets,
  statusCakeMonitorBound,
  statusCakeReceiverUrl,
  statusCakeSetupApi,
  syncStatusCakeContactGroups,
  type StatusCakeDelivery,
} from '../setup';

const KEY = '00000000-0000-4000-8000-0000000000aa';
const ORIGIN = 'https://sre.example';
const SECRET = 'a'.repeat(32);

/** In-memory StatusCake v1 with the form-encoded write semantics the real API documents. */
function fakeStatusCake(seed: {
  tests: Array<{ id: string; name: string; contact_groups: string[] }>;
  groups?: Array<{ id: string; name: string; ping_url?: string }>;
  failOn?: (method: string, path: string) => number | undefined;
}) {
  const tests = new Map(seed.tests.map((t) => [t.id, { ...t }]));
  const groups = new Map((seed.groups ?? []).map((g) => [g.id, { ...g }]));
  let nextId = 900;
  const writes: string[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const method = init?.method ?? 'GET';
    const status = seed.failOn?.(method, url.pathname);
    if (status) return new Response(JSON.stringify({ message: 'nope' }), { status });
    const form = new URLSearchParams(String(init?.body ?? ''));
    const parts = url.pathname.split('/').filter(Boolean); // v1, resource, id?
    if (method !== 'GET') writes.push(`${method} ${url.pathname}`);
    const page = (items: unknown[]) =>
      Response.json({
        data: items,
        metadata: { page: 1, page_count: 1, total_count: items.length },
      });
    if (method === 'GET' && parts[1] === 'uptime' && !parts[2]) return page([...tests.values()]);
    if (method === 'GET' && parts[1] === 'uptime')
      return tests.has(parts[2]!)
        ? Response.json({ data: tests.get(parts[2]!) })
        : Response.json({ message: 'No results found' }, { status: 404 });
    if (method === 'GET' && parts[1] === 'contact-groups') return page([...groups.values()]);
    if (method === 'POST' && parts[1] === 'contact-groups') {
      const id = String(nextId++);
      groups.set(id, { id, name: form.get('name')!, ping_url: form.get('ping_url')! });
      return Response.json({ data: { new_id: id } }, { status: 201 });
    }
    if (method === 'PUT' && parts[1] === 'contact-groups') {
      const group = groups.get(parts[2]!)!;
      group.ping_url = form.get('ping_url') ?? group.ping_url;
      return new Response(null, { status: 204 });
    }
    if (method === 'PUT' && parts[1] === 'uptime') {
      // StatusCake replaces the whole list; an empty element clears it.
      tests.get(parts[2]!)!.contact_groups = form.getAll('contact_groups[]').filter(Boolean);
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && parts[1] === 'contact-groups') {
      groups.delete(parts[2]!);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { tests, groups, writes, api: statusCakeSetupApi('bearer', fetchImpl) };
}

const noSleep = async () => {};
const sync = (
  api: ReturnType<typeof fakeStatusCake>['api'],
  delivery: StatusCakeDelivery,
  apply = true,
) =>
  syncStatusCakeContactGroups(api, {
    delivery,
    webhookKey: KEY,
    origin: ORIGIN,
    secret: SECRET,
    apply,
    sleep: noSleep,
  });
const auto = (excluded: string[] = []): StatusCakeDelivery => ({
  mode: 'auto',
  selected: [],
  excluded,
});
const urlFor = (id: string) => statusCakeReceiverUrl(ORIGIN, KEY, id, SECRET);

describe('StatusCake contact-group setup', () => {
  test('all-tests mode adds one group per test and keeps every existing contact', async () => {
    const sc = fakeStatusCake({
      tests: [
        { id: '73', name: 'Checkout', contact_groups: ['5'] },
        { id: '74', name: 'Status page', contact_groups: [] },
      ],
      groups: [{ id: '5', name: 'On-call email' }],
    });
    const result = await sync(sc.api, auto());
    expect(result.error).toBeUndefined();
    expect(result.tests.map((t) => [t.id, t.state])).toEqual([
      ['73', 'created'],
      ['74', 'created'],
    ]);
    const checkout = sc.tests.get('73')!;
    expect(checkout.contact_groups).toHaveLength(2);
    expect(checkout.contact_groups).toContain('5');
    const ours = sc.groups.get(checkout.contact_groups.find((g) => g !== '5')!)!;
    expect(ours).toMatchObject({ name: 'SRE Platform: Checkout', ping_url: urlFor('73') });
    expect(ours.ping_url).toBe(`https://sre.example/webhooks/statuscake/${KEY}/73?Token=${SECRET}`);
  });

  test('a second pass changes nothing', async () => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: ['5'] }] });
    await sync(sc.api, auto());
    const writes = sc.writes.length;
    const again = await sync(sc.api, auto());
    expect(again.changes).toBe(0);
    expect(again.tests[0]!.state).toBe('ready');
    expect(sc.writes).toHaveLength(writes);
  });

  test('excluding a test detaches and deletes only the platform group', async () => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: ['5'] }] });
    await sync(sc.api, auto());
    const result = await sync(sc.api, auto(['73']));
    expect(result.tests[0]!.state).toBe('removed');
    expect(sc.tests.get('73')!.contact_groups).toEqual(['5']);
    expect([...sc.groups.keys()]).toEqual([]);
  });

  test('removing the last group clears the list with an empty element', async () => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: [] }] });
    await sync(sc.api, auto());
    await sync(sc.api, { mode: 'custom', selected: [], excluded: [] });
    expect(sc.tests.get('73')!.contact_groups).toEqual([]);
  });

  test('chosen-tests mode ignores tests that were not chosen', async () => {
    const sc = fakeStatusCake({
      tests: [
        { id: '73', name: 'Checkout', contact_groups: [] },
        { id: '74', name: 'Status page', contact_groups: [] },
      ],
    });
    const result = await sync(sc.api, { mode: 'custom', selected: ['74'], excluded: [] });
    expect(result.tests.map((t) => [t.id, t.state])).toEqual([
      ['73', 'not_bound'],
      ['74', 'created'],
    ]);
    expect(sc.tests.get('73')!.contact_groups).toEqual([]);
  });

  test('repairs a group whose URL has an old secret, and deletes groups for deleted tests', async () => {
    const stale = statusCakeReceiverUrl(ORIGIN, KEY, '73', 'b'.repeat(32));
    const sc = fakeStatusCake({
      tests: [{ id: '73', name: 'Checkout', contact_groups: ['800'] }],
      groups: [
        { id: '800', name: 'SRE Platform: Checkout', ping_url: stale },
        { id: '801', name: 'SRE Platform: Gone', ping_url: urlFor('99') },
        {
          id: '802',
          name: 'Other platform',
          ping_url: `https://sre.example/webhooks/statuscake/other/73`,
        },
      ],
    });
    const result = await sync(sc.api, auto());
    expect(result.tests[0]!.state).toBe('repaired');
    expect(sc.groups.get('800')!.ping_url).toBe(urlFor('73'));
    expect(sc.groups.has('801')).toBe(false);
    // A group routed to a different connection is never touched.
    expect(sc.groups.has('802')).toBe(true);
  });

  test('a report-only pass writes nothing', async () => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: [] }] });
    const result = await sync(sc.api, auto(), false);
    expect(result.tests[0]!.state).toBe('missing');
    expect(sc.writes).toEqual([]);
  });

  test.each([
    [429, 'rate_limited'],
    [403, 'permission_denied'],
    [422, 'provider_rejected'],
  ] as const)('a %i stops the pass as %s and a later pass resumes', async (status, category) => {
    let fail = true;
    const sc = fakeStatusCake({
      tests: [{ id: '73', name: 'Checkout', contact_groups: [] }],
      failOn: (method) => (fail && method === 'POST' ? status : undefined),
    });
    const stopped = await sync(sc.api, auto());
    expect(stopped.error?.category).toBe(category);
    fail = false;
    expect((await sync(sc.api, auto())).tests[0]!.state).toBe('created');
  });
});

describe('StatusCake binding', () => {
  test('all-tests mode binds every test except exclusions; chosen mode binds only chosen', () => {
    const autoSettings = {
      eventTransport: 'direct',
      setupMode: 'auto',
      excludedMonitorIds: ['74'],
    };
    expect(statusCakeMonitorBound(autoSettings, '73')).toBe(true);
    expect(statusCakeMonitorBound(autoSettings, '74')).toBe(false);
    const custom = { eventTransport: 'direct', setupMode: 'custom', uptimeMonitorIds: ['74'] };
    expect(statusCakeMonitorBound(custom, '73')).toBe(false);
    expect(statusCakeMonitorBound(custom, '74')).toBe(true);
    // A row saved before setup modes existed keeps its explicit list.
    expect(
      statusCakeMonitorBound({ eventTransport: 'direct', uptimeMonitorIds: ['73'] }, '74'),
    ).toBe(false);
    expect(statusCakeMonitorBound({ eventTransport: 'none', setupMode: 'auto' }, '73')).toBe(false);
    expect(statusCakeMonitorBound(autoSettings, '../73')).toBe(false);
  });

  test('read responses never carry the platform webhook secret', () => {
    expect(
      redactStatusCakeSecrets({
        data: [{ id: '1', ping_url: `https://sre.example/x?Token=${SECRET}&a=1`, name: 'n' }],
      }),
    ).toEqual({
      data: [{ id: '1', ping_url: 'https://sre.example/x?Token=[redacted]&a=1', name: 'n' }],
    });
  });
});

describe('StatusCake setup never drops an operator contact group', () => {
  test.each([
    [
      'a missing contact-group list',
      (t: Record<string, unknown>) => ({ ...t, contact_groups: undefined }),
    ],
    [
      'an unreadable contact-group ID',
      (t: Record<string, unknown>) => ({ ...t, contact_groups: ['5', 'bad id'] }),
    ],
    ['a different test', (t: Record<string, unknown>) => ({ ...t, id: '999' })],
  ])('stops without writing the test on %s', async (_label, corrupt) => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: ['5'] }] });
    const api = {
      ...sc.api,
      get: async (path: string, query?: Record<string, string | number>) => {
        const body = (await sc.api.get(path, query)) as { data: Record<string, unknown> };
        return path === '/v1/uptime/73' ? { data: corrupt(body.data) } : body;
      },
    };
    const result = await sync(api, auto());
    expect(result.error?.category).toBe('provider_rejected');
    expect(sc.tests.get('73')!.contact_groups).toEqual(['5']);
    expect(sc.writes.filter((w) => w.startsWith('PUT /v1/uptime'))).toEqual([]);
  });
});

describe('StatusCake setup acts only on a complete, confirmed view', () => {
  test('a hand-made group at the same address is never adopted, changed, or deleted', async () => {
    const sc = fakeStatusCake({
      tests: [{ id: '73', name: 'Checkout', contact_groups: ['7'] }],
      groups: [{ id: '7', name: 'My webhook', ping_url: urlFor('73') }],
    });
    await sync(sc.api, { mode: 'custom', selected: [], excluded: [] });
    expect(sc.groups.get('7')).toMatchObject({ name: 'My webhook', ping_url: urlFor('73') });
    expect(sc.tests.get('73')!.contact_groups).toEqual(['7']);
  });

  test('a test missing from the list is only treated as deleted once StatusCake returns 404', async () => {
    const sc = fakeStatusCake({
      tests: [{ id: '73', name: 'Checkout', contact_groups: ['800'] }],
      groups: [{ id: '800', name: 'SRE Platform: Checkout', ping_url: urlFor('73') }],
    });
    // The test moved between pages while the list was read, so the list omits it.
    const api = {
      ...sc.api,
      get: async (path: string, query?: Record<string, string | number>) =>
        path === '/v1/uptime'
          ? { data: [], metadata: { page: 1, page_count: 1 } }
          : sc.api.get(path, query),
    };
    await sync(api, auto());
    expect(sc.groups.has('800')).toBe(true);
    sc.tests.delete('73');
    await sync(api, auto());
    expect(sc.groups.has('800')).toBe(false);
  });

  test('more than 2,000 tests stops the pass before any write', async () => {
    const sc = fakeStatusCake({ tests: [{ id: '73', name: 'Checkout', contact_groups: [] }] });
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: String(1000 + i),
      name: `t${i}`,
      contact_groups: [],
    }));
    const api = {
      ...sc.api,
      get: async (path: string, query?: Record<string, string | number>) =>
        path === '/v1/uptime'
          ? { data: full, metadata: { page: query?.page, page_count: 21 } }
          : sc.api.get(path, query),
    };
    const result = await sync(api, auto());
    expect(result.error?.message).toContain('more than 2,000');
    expect(sc.writes).toEqual([]);
  });
});
