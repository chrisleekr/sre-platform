import { describe, expect, test } from 'vitest';
import {
  ConnectorRegistry,
  alertmanagerEventToken,
  makeStatusCakeConnector,
} from '@sre/connectors';
import { connectorConfigs, connectorEventCredentialKey, memberships } from '@sre/db';
import { eq } from 'drizzle-orm';
import { registerTestConnector } from './connector-registry';
import { createFixture } from './connectors.fixture';

interface SetupBody {
  tests: Array<{ id: string; state: string }>;
  error?: unknown;
}

const __fixture = createFixture();

/** Minimal StatusCake v1: uptime tests and contact groups with form-encoded writes. */
function fakeStatusCake() {
  const tests = new Map([
    ['73', { id: '73', name: 'Checkout', status: 'up', paused: false, contact_groups: ['5'] }],
    [
      '74',
      {
        id: '74',
        name: 'Status page',
        status: 'down',
        paused: false,
        contact_groups: [] as string[],
      },
    ],
  ]);
  const groups = new Map<string, { id: string; name: string; ping_url?: string }>([
    ['5', { id: '5', name: 'On-call email' }],
  ]);
  let nextId = 900;
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const form = new URLSearchParams(String(init?.body ?? ''));
    const [, resource, id] = url.pathname.split('/').filter(Boolean);
    const page = (items: unknown[]) =>
      Response.json({
        data: items,
        metadata: { page: 1, page_count: 1, total_count: items.length },
      });
    if (method === 'GET' && resource === 'uptime')
      return id ? Response.json({ data: tests.get(id) }) : page([...tests.values()]);
    if (method === 'GET' && resource === 'contact-groups') return page([...groups.values()]);
    if (method === 'POST' && resource === 'contact-groups') {
      const newId = String(nextId++);
      groups.set(newId, { id: newId, name: form.get('name')!, ping_url: form.get('ping_url')! });
      return Response.json({ data: { new_id: newId } }, { status: 201 });
    }
    if (method === 'PUT' && resource === 'uptime') {
      tests.get(id!)!.contact_groups = form.getAll('contact_groups[]').filter(Boolean);
      return new Response(null, { status: 204 });
    }
    if (method === 'DELETE' && resource === 'contact-groups') {
      groups.delete(id!);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { tests, groups, fetchImpl };
}

describe('StatusCake notification setup', () => {
  test('all-tests mode generates the webhook secret and creates contact groups without losing contacts', async () => {
    const sc = fakeStatusCake();
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'statuscake', (config) =>
      makeStatusCakeConnector(config, sc.fetchImpl),
    );
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry,
      statusCakeFetch: sc.fetchImpl,
    });
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA));
    const put = (body: unknown) =>
      route.request('/connectors/statuscake', {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
      });
    const direct = {
      eventTransport: 'direct',
      setupMode: 'auto',
      excludedMonitorIds: [],
      alertChannel: 'C07ALERTS',
      receiverOrigin: 'https://sre.example',
    };
    try {
      expect((await put({ settings: {}, credential: 'bearer-token' })).status).toBe(200);
      const { id } = await __fixture.activeConnector('statuscake');
      const verify = () =>
        route.request(`/connectors/statuscake/${id}/test`, { method: 'POST', headers });
      expect((await verify()).status).toBe(200);

      // Only the modern API token: a user-supplied webhook Token is refused outright.
      const legacy = await put({ settings: direct, eventToken: 'a'.repeat(32) });
      expect(legacy.status).toBe(400);
      // StatusCake cannot call a non-HTTPS address, so saving one is refused.
      expect(
        (await put({ settings: { ...direct, receiverOrigin: 'http://localhost:43000' } })).status,
      ).toBe(400);
      expect(
        (
          await put({
            settings: { ...direct, setupMode: 'custom', uptimeMonitorIds: [] },
          })
        ).status,
      ).toBe(400);

      expect((await put({ settings: direct })).status).toBe(200);
      const secret = alertmanagerEventToken(
        await __fixture.secrets.get(__fixture.tenantA, connectorEventCredentialKey(id)),
      );
      expect(secret).toMatch(/^[a-f0-9]{32}$/);
      // A later save keeps the secret, so ping URLs already in StatusCake stay valid.
      expect((await put({ settings: { ...direct, excludedMonitorIds: ['74'] } })).status).toBe(200);
      expect(
        alertmanagerEventToken(
          await __fixture.secrets.get(__fixture.tenantA, connectorEventCredentialKey(id)),
        ),
      ).toBe(secret);
      await verify();

      const listed = await route.request(`/connectors/statuscake/${id}/uptime-tests`, { headers });
      expect(listed.status).toBe(200);
      expect(((await listed.json()) as SetupBody).tests.map((t) => [t.id, t.state])).toEqual([
        ['73', 'missing'],
        ['74', 'not_bound'],
      ]);
      expect(sc.groups.size).toBe(1);

      const setup = await route.request(`/connectors/statuscake/${id}/setup`, {
        method: 'POST',
        headers,
      });
      expect(setup.status).toBe(200);
      const body = (await setup.json()) as SetupBody;
      expect(body.error).toBeUndefined();
      expect(body.tests.map((t) => [t.id, t.state])).toEqual([
        ['73', 'created'],
        ['74', 'not_bound'],
      ]);
      const checkout = sc.tests.get('73')!;
      expect(checkout.contact_groups[0]).toBe('5');
      const ours = sc.groups.get(checkout.contact_groups[1]!)!;
      expect(ours.ping_url).toBe(
        `https://sre.example/webhooks/statuscake/${id}/73?Token=${secret}`,
      );
      expect(sc.tests.get('74')!.contact_groups).toEqual([]);
    } finally {
      await route.request('/connectors/statuscake', { method: 'DELETE', headers });
    }
  });

  test('setup refuses a connection that has not been verified', async () => {
    const sc = fakeStatusCake();
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      statusCakeFetch: sc.fetchImpl,
    });
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA));
    try {
      await route.request('/connectors/statuscake', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ settings: {}, credential: 'bearer-token' }),
      });
      const { id } = await __fixture.activeConnector('statuscake');
      const setup = await route.request(`/connectors/statuscake/${id}/setup`, {
        method: 'POST',
        headers,
      });
      expect(setup.status).toBe(409);
      expect(sc.groups.size).toBe(1);
    } finally {
      await route.request('/connectors/statuscake', { method: 'DELETE', headers });
    }
  });

  async function verifiedConnection(
    route: ReturnType<typeof __fixture.makeConnApp>,
    headers: Record<string, string>,
    settings: Record<string, unknown>,
  ) {
    await route.request('/connectors/statuscake', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settings: {}, credential: 'bearer-token' }),
    });
    const { id } = await __fixture.activeConnector('statuscake');
    await __fixture.admin.db
      .update(connectorConfigs)
      .set({ settings, enabled: true })
      .where(eq(connectorConfigs.id, id));
    return id;
  }

  test('a hand-configured connection can change its token without adopting managed setup', async () => {
    const sc = fakeStatusCake();
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      statusCakeFetch: sc.fetchImpl,
    });
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA));
    try {
      const legacy = {
        eventTransport: 'direct',
        alertChannel: 'C07ALERTS',
        uptimeMonitorIds: ['73'],
      };
      const id = await verifiedConnection(route, headers, legacy);
      const renamed = await route.request('/connectors/statuscake', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ name: 'Uptime', credential: 'new-token' }),
      });
      expect(renamed.status).toBe(200);
      const [row] = await __fixture.admin.db
        .select({ settings: connectorConfigs.settings })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.id, id));
      expect(row!.settings).toMatchObject({ eventTransport: 'direct', uptimeMonitorIds: ['73'] });
      expect(row!.settings).not.toHaveProperty('receiverOrigin');
    } finally {
      await route.request('/connectors/statuscake', { method: 'DELETE', headers });
    }
  });

  test('turning alerts off removes the groups, then stops marking the connection as managed', async () => {
    const sc = fakeStatusCake();
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      statusCakeFetch: sc.fetchImpl,
    });
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA));
    try {
      const id = await verifiedConnection(route, headers, {
        eventTransport: 'direct',
        setupMode: 'auto',
        alertChannel: 'C07ALERTS',
        receiverOrigin: 'https://sre.example',
      });
      await __fixture.secrets.put(
        __fixture.tenantA,
        connectorEventCredentialKey(id),
        JSON.stringify({ version: 1, token: 'a'.repeat(32) }),
      );
      const setup = () =>
        route.request(`/connectors/statuscake/${id}/setup`, { method: 'POST', headers });
      await setup();
      expect(sc.groups.size).toBe(3);
      await __fixture.admin.db
        .update(connectorConfigs)
        .set({
          settings: {
            eventTransport: 'none',
            setupMode: 'auto',
            receiverOrigin: 'https://sre.example',
          },
        })
        .where(eq(connectorConfigs.id, id));
      expect((await setup()).status).toBe(200);
      expect([...sc.groups.keys()]).toEqual(['5']);
      expect(sc.tests.get('73')!.contact_groups).toEqual(['5']);
      const [row] = await __fixture.admin.db
        .select({ settings: connectorConfigs.settings })
        .from(connectorConfigs)
        .where(eq(connectorConfigs.id, id));
      expect(row!.settings).not.toHaveProperty('receiverOrigin');
    } finally {
      await route.request('/connectors/statuscake', { method: 'DELETE', headers });
    }
  });

  test('a running setup refuses a second one, and members cannot spend the rate limit listing tests', async () => {
    const sc = fakeStatusCake();
    const held = new Set<string>();
    const cache = {
      set: async () => {},
      get: async () => [],
      acquireOwnedLease: async (name: string) => (held.has(name) ? null : (held.add(name), 'mine')),
      releaseOwnedLease: async (name: string) => {
        held.delete(name);
      },
    };
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      statusCakeFetch: sc.fetchImpl,
      cache,
    });
    const headers = __fixture.bearer(await __fixture.sign(__fixture.orgA));
    try {
      const id = await verifiedConnection(route, headers, {
        eventTransport: 'direct',
        setupMode: 'auto',
        alertChannel: 'C07ALERTS',
        receiverOrigin: 'https://sre.example',
      });
      held.add(`statuscake-setup:${id}`);
      const busy = await route.request(`/connectors/statuscake/${id}/setup`, {
        method: 'POST',
        headers,
      });
      expect(busy.status).toBe(409);
      expect(sc.groups.size).toBe(1);

      await __fixture.admin.db
        .update(memberships)
        .set({ role: 'member' })
        .where(eq(memberships.tenantId, __fixture.tenantA));
      const listed = await route.request(`/connectors/statuscake/${id}/uptime-tests`, { headers });
      expect(listed.status).toBe(403);
    } finally {
      await __fixture.admin.db
        .update(memberships)
        .set({ role: 'admin' })
        .where(eq(memberships.tenantId, __fixture.tenantA));
      await route.request('/connectors/statuscake', { method: 'DELETE', headers });
    }
  });
});
