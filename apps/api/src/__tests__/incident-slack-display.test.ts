import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import {
  makeSecretStore,
  persistSurfaceIdentity,
  surfaceIdentities,
  surfaceBotTokenKey,
} from '@sre/db';
import { eq } from 'drizzle-orm';
import { createFixture } from './incidents.fixture';

const fetch = vi.fn(async () =>
  Response.json({ ok: true, user: { profile: { display_name: 'Responder' } } }),
);
beforeAll(() => vi.stubGlobal('fetch', fetch));
afterAll(() => vi.unstubAllGlobals());
const fixture = createFixture();

test('authenticated history resolves retained Slack names without changing stored content', async () => {
  const secrets = makeSecretStore(fixture.app.db, fixture.KEY);
  const key = surfaceBotTokenKey('slack');
  await secrets.put(fixture.tenantC, key, 'test-only-slack-token');
  try {
    const original = await fixture.hub.append(fixture.tenantC, fixture.originIncidentId, {
      author: 'human',
      originSurface: 'slack',
      content: '[U111]: <@U222> check health',
    });
    fetch.mockClear();
    const foreign = await fixture.api.request(
      `/incidents/${fixture.originIncidentId}/messages`,
      fixture.auth(await fixture.sign(fixture.orgB)),
    );
    expect(foreign.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    const response = await fixture.api.request(
      `/incidents/${fixture.originIncidentId}/messages`,
      fixture.auth(await fixture.sign(fixture.orgC)),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; content: string; displayContent?: string }>;
    };
    expect(body.messages.find((message) => message.id === original.id)).toMatchObject({
      content: '[U111]: <@U222> check health',
      displayContent: 'Responder: @Responder check health',
    });
    const retained = await fixture.hub.history(fixture.tenantC, fixture.originIncidentId);
    expect(retained.find((message) => message.id === original.id)?.content).toBe(original.content);
  } finally {
    await secrets.delete(fixture.tenantC, key);
  }
});

test('ordinary replies use canonical attribution even when text names another sender', async () => {
  const secrets = makeSecretStore(fixture.app.db, fixture.KEY);
  const key = surfaceBotTokenKey('slack');
  await secrets.put(fixture.tenantC, key, 'test-only-slack-token');
  await persistSurfaceIdentity(fixture.app.db, fixture.tenantC, {
    surface: 'slack',
    surfaceUserId: 'U111',
    authorUserId: fixture.tenantCUserId,
  });
  try {
    const original = await fixture.hub.append(fixture.tenantC, fixture.originIncidentId, {
      author: 'human',
      originSurface: 'slack',
      authorUserId: fixture.tenantCUserId,
      content: 'Please check again',
    });
    const response = await fixture.api.request(
      `/incidents/${fixture.originIncidentId}/messages`,
      fixture.auth(await fixture.sign(fixture.orgC)),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      messages: Array<{ id: string; authorDisplayName?: string }>;
    };
    expect(body.messages.find((message) => message.id === original.id)?.authorDisplayName).toBe(
      'Responder',
    );
  } finally {
    await fixture.admin.db
      .delete(surfaceIdentities)
      .where(eq(surfaceIdentities.tenantId, fixture.tenantC));
    await secrets.delete(fixture.tenantC, key);
  }
});
