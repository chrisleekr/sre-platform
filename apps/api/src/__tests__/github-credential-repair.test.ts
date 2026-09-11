import { expect, test } from 'vitest';
import { githubPrivateKey, githubWebhookSecret, githubSmeeUrl } from '@sre/connectors';
import { connectorCredentialKey, connectorConfigs, withTenant } from '@sre/db';
import { eq } from 'drizzle-orm';
import { createFixture } from './connectors.fixture';
import { createHmac, randomUUID } from 'node:crypto';
import { githubWebhookRoutes } from '../github-webhook';

const fixture = createFixture();
test('updates independent GitHub credentials without losing the other encrypted values', async () => {
  const route = fixture.makeConnApp();
  const settings = {
    appId: 'Iv1.repair',
    installationId: '42',
    repo: 'acme/repo',
    eventTransport: 'smee',
    smeeUrl: 'https://smee.io/original-channel',
  };
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  const created = await route.request('/connectors/github', {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      settings,
      credential: 'original-key',
      webhookSecret: 'original-webhook-secret',
    }),
  });
  expect(created.status).toBe(200);
  const { connectorId } = (await created.json()) as { connectorId: string };
  const { smeeUrl: _omitted, ...unchangedSettings } = settings;
  for (const replacement of [
    { webhookSecret: 'replacement-webhook-secret' },
    { credential: 'replacement-key' },
  ]) {
    const saved = await route.request(`/connectors/github/${connectorId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ settings: unchangedSettings, ...replacement }),
    });
    expect(saved.status).toBe(200);
    const stored = await fixture.secrets.get(fixture.tenantA, connectorCredentialKey(connectorId));
    expect(githubWebhookSecret(stored!)).toBe('replacement-webhook-secret');
    expect(githubPrivateKey(stored!)).toBe(
      'credential' in replacement ? 'replacement-key' : 'original-key',
    );
    expect(githubSmeeUrl(stored!)).toBe('https://smee.io/original-channel');
    expect(await saved.text()).not.toContain('replacement-');
  }
  const hooks = githubWebhookRoutes({
    adminDb: fixture.admin.db,
    appDb: fixture.app.db,
    secrets: fixture.secrets,
  });
  const body = JSON.stringify({ zen: 'Recovery test', hook_id: 9 });
  const deliver = (secret: string) =>
    hooks.request(`/${connectorId}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-github-delivery': randomUUID(),
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
      },
      body,
    });
  expect((await deliver('original-webhook-secret')).status).toBe(401);
  const accepted = await deliver('replacement-webhook-secret');
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ accepted: true, duplicate: false });
  const [health] = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx
      .select({
        failed: connectorConfigs.eventFailureCategory,
        succeeded: connectorConfigs.eventSucceededAt,
        count: connectorConfigs.eventCount,
      })
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, connectorId)),
  );
  expect(health?.failed).toBeNull();
  expect(health?.succeeded).toBeInstanceOf(Date);
  expect(health?.count).toBe(1);
});
