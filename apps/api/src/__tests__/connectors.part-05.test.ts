import { describe, expect, test, vi } from 'vitest';

import { gitLabSmeeUrl, gitLabWebhookSigningToken } from '@sre/connectors';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('GitLab project discovery', () => {
  test('stores GitLab Smee and HMAC credentials write-only and reconciles without a restart', async () => {
    const gitlabSmee = { replace: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { gitlabSmee });
    const signingToken = `whsec_${Buffer.alloc(32, 5).toString('base64')}`;
    const settings = {
      baseUrl: 'https://gitlab.example.com',
      groupId: 7,
      groupPath: 'platform',
      groupName: 'Platform',
      eventTransport: 'smee',
    };
    try {
      const saved = await route.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { ...settings, smeeUrl: 'https://smee.io/gitlab-channel' },
          credential: 'group-token',
          webhookSigningToken: signingToken,
        }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ ok: true, relayStatus: 'connected' });
      const stored = await __fixture.activeCredential('gitlab');
      const connector = await __fixture.activeConnector('gitlab');
      expect(gitLabSmeeUrl(stored!)).toBe('https://smee.io/gitlab-channel');
      expect(gitLabWebhookSigningToken(stored!)).toBe(signingToken);
      expect(gitlabSmee.replace).toHaveBeenCalledWith(
        __fixture.tenantA,
        connector.id,
        'https://smee.io/gitlab-channel',
        connector.id,
      );

      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const listedText = await listed.text();
      expect(listedText).not.toContain('gitlab-channel');
      expect(listedText).not.toContain(signingToken);
      expect(listedText).toContain('"smeeConfigured":true');
      expect(listedText).toContain('"webhookSigningTokenConfigured":true');

      const edited = await route.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings }),
      });
      expect(edited.status).toBe(200);
      expect(gitLabSmeeUrl((await __fixture.activeCredential('gitlab'))!)).toBe(
        'https://smee.io/gitlab-channel',
      );

      const direct = await route.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { ...settings, eventTransport: 'direct' } }),
      });
      expect(direct.status).toBe(200);
      expect(await direct.json()).toMatchObject({ relayStatus: 'stopped' });
      expect(gitLabSmeeUrl((await __fixture.activeCredential('gitlab'))!)).toBe(null);
      expect(gitlabSmee.stop).toHaveBeenCalledWith(connector.id);
    } finally {
      await route.request('/connectors/gitlab', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });
});
