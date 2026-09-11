import { afterEach, expect, test, vi } from 'vitest';
import { connectorConfigs, withTenant } from '@sre/db';
import { eq } from 'drizzle-orm';
import { createFixture } from './connectors.fixture';

const fixture = createFixture();
afterEach(() => vi.unstubAllGlobals());

test('a dedicated GitHub App manifest uses the prepared webhook path', async () => {
  const app = fixture.makeConnApp();
  const setupId = crypto.randomUUID();
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  const response = await app.request('/connectors/github/manifest/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      setupId,
      name: `manifest-${setupId}`,
      ownerType: 'personal',
      deliveryMode: 'direct',
      deliveryUrl: 'https://api.example.com',
      dashboardUrl: 'https://sre.example.com',
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    localWebhookPath: string;
    manifest: { hook_attributes: { url: string } };
  };
  expect(body.localWebhookPath).toBe(`/webhooks/github/${setupId}`);
  expect(body.manifest.hook_attributes.url).toBe(
    `https://api.example.com/webhooks/github/${setupId}`,
  );
  const duplicate = await app.request('/connectors/github/manifest/start', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      setupId,
      name: `different-${setupId}`,
      ownerType: 'personal',
      deliveryMode: 'direct',
      deliveryUrl: 'https://api.example.com',
      dashboardUrl: 'https://sre.example.com',
    }),
  });
  expect(duplicate.status).toBe(409);
});

test.each(['github', 'gitlab', 'prometheus'])(
  'allocates %s address without creating a receiver',
  async (type) => {
    const app = fixture.makeConnApp();
    const response = await app.request(`/connectors/${type}/prepare-delivery`, {
      method: 'POST',
      headers: fixture.bearer(await fixture.sign(fixture.orgA)),
      body: JSON.stringify({ transport: 'direct' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { setupId: string; webhookPath: string };
    expect(body.setupId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.webhookPath).toBe(
      `/webhooks/${type === 'prometheus' ? 'alertmanager' : type}/${body.setupId}`,
    );
    const rows = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, body.setupId)),
    );
    expect(rows).toHaveLength(0);
  },
);

test('requires authentication before preparing a channel', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const response = await fixture.makeConnApp().request('/connectors/github/prepare-delivery', {
    method: 'POST',
    body: JSON.stringify({ transport: 'smee' }),
  });
  expect(response.status).toBe(401);
  expect(fetch).not.toHaveBeenCalled();
});

test('creates a validated Smee URL while retaining an allocated ID', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(null, {
        status: 307,
        headers: { location: 'https://smee.io/generated-channel-test' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const id = crypto.randomUUID();
  const response = await fixture.makeConnApp().request('/connectors/github/prepare-delivery', {
    method: 'POST',
    headers: fixture.bearer(await fixture.sign(fixture.orgA)),
    body: JSON.stringify({ transport: 'smee', setupId: id }),
  });
  expect(await response.json()).toMatchObject({
    setupId: id,
    smeeUrl: 'https://smee.io/generated-channel-test',
    webhookPath: `/webhooks/github/${id}`,
  });
  expect(fetch).toHaveBeenCalledWith(
    'https://smee.io/new',
    expect.objectContaining({
      method: 'HEAD',
      redirect: 'manual',
      signal: expect.any(AbortSignal),
    }),
  );
});

test.each([
  'https://other.example/channel-secret',
  'http://smee.io/channel-secret',
  'https://smee.io:444/channel-secret',
  'https://smee.io/new',
  'https://smee.io/channel-secret?token=secret',
])('rejects an unsafe channel response without disclosing it', async (url) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(null, { status: 307, headers: { location: url } })),
  );
  const response = await fixture.makeConnApp().request('/connectors/gitlab/prepare-delivery', {
    method: 'POST',
    headers: fixture.bearer(await fixture.sign(fixture.orgA)),
    body: JSON.stringify({ transport: 'smee' }),
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain(url);
});

test('prepared saves retain the address across retries and cannot overwrite another tenant', async () => {
  const app = fixture.makeConnApp();
  const id = crypto.randomUUID();
  const body = {
    setupId: id,
    name: `prepared-${id}`,
    credential: 'test-private-key',
    webhookSecret: 'test-webhook-secret',
    settings: { appId: id, installationId: '42', eventTransport: 'direct' },
  };
  const request = (org: string, value = body) =>
    app.request('/connectors/github', {
      method: 'POST',
      headers: fixture.bearer(org),
      body: JSON.stringify(value),
    });
  const tokenA = await fixture.sign(fixture.orgA);
  const first = await request(tokenA);
  expect(first.status).toBe(200);
  expect(await first.json()).toMatchObject({
    connectorId: id,
    webhookPath: `/webhooks/github/${id}`,
  });
  expect((await request(tokenA)).status).toBe(200);
  const other = await request(await fixture.sign(fixture.orgB), { ...body, name: 'other-tenant' });
  expect(other.status).not.toBe(200);
  const rows = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.select().from(connectorConfigs).where(eq(connectorConfigs.id, id)),
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.name).toBe(body.name);
  expect(rows[0]?.enabled).toBe(false);
});
