import { describe, expect, test, vi } from 'vitest';

import { eq } from 'drizzle-orm';

import {
  connectorConfigs,
  connectorCredentialKey,
  githubManifestSessions,
  withTenant,
} from '@sre/db';

import {
  GitHubInstallationDiscoveryError,
  githubPrivateKey,
  githubSmeeUrl,
  githubWebhookSecret,
} from '@sre/connectors';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('GitHub App connector lifecycle', () => {
  test('creates and imports a dedicated read-only App manifest without exposing its credentials', async () => {
    const convertManifest = vi.fn(async () => ({
      appId: '901',
      appSlug: 'sre-platform-acme',
      appUrl: 'https://github.com/apps/sre-platform-acme',
      privateKey: 'manifest-private-key',
      webhookSecret: 'manifest-webhook-secret',
    }));
    const githubSmee = { replace: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      convertManifest,
      githubSmee,
    });
    try {
      const start = await route.request('/connectors/github/manifest/start', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          ownerType: 'personal',
          deliveryMode: 'smee',
          deliveryUrl: 'https://smee.io/sre-platform-test',
          dashboardUrl: 'http://localhost:45173',
        }),
      });
      expect(start.status).toBe(200);
      const started = (await start.json()) as {
        actionUrl: string;
        state: string;
        webhookUrl: string;
        localWebhookPath: string;
        manifest: Record<string, unknown>;
      };
      expect(started).toMatchObject({
        webhookUrl: 'https://smee.io/sre-platform-test',
        manifest: {
          hook_attributes: { url: 'https://smee.io/sre-platform-test', active: true },
          default_permissions: {
            contents: 'read',
            pull_requests: 'read',
            actions: 'read',
            deployments: 'read',
          },
          default_events: [
            'push',
            'pull_request',
            'workflow_run',
            'deployment',
            'deployment_status',
            'repository',
          ],
        },
      });
      expect(started.actionUrl).toContain('https://github.com/settings/apps/new?state=');
      expect(started.localWebhookPath).toMatch(/^\/webhooks\/github\/[0-9a-f-]+$/);

      const complete = await route.request('/connectors/github/manifest/complete', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ code: 'one-time-code', state: started.state }),
      });
      expect(complete.status).toBe(200);
      expect(convertManifest).toHaveBeenCalledWith('one-time-code');
      const completedText = await complete.text();
      expect(JSON.parse(completedText)).toMatchObject({
        appId: '901',
        appSlug: 'sre-platform-acme',
        eventTransport: 'smee',
        relayStatus: 'connected',
        localWebhookPath: started.localWebhookPath,
      });
      expect(completedText).not.toContain('manifest-private-key');
      expect(completedText).not.toContain('manifest-webhook-secret');

      const stored = await __fixture.activeCredential('github');
      const connector = await __fixture.activeConnector('github');
      expect(githubPrivateKey(stored!)).toBe('manifest-private-key');
      expect(githubWebhookSecret(stored!)).toBe('manifest-webhook-secret');
      expect(githubSmeeUrl(stored!)).toBe('https://smee.io/sre-platform-test');
      expect(githubSmee.replace).toHaveBeenCalledWith(
        __fixture.tenantA,
        connector.id,
        'https://smee.io/sre-platform-test',
        started.localWebhookPath.split('/').at(-1),
      );
      const [row] = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'github')),
      );
      expect(row).toMatchObject({
        enabled: false,
        settings: { appId: '901', appSlug: 'sre-platform-acme', eventTransport: 'smee' },
      });
      expect(`/webhooks/github/${row!.webhookKey}`).toBe(started.localWebhookPath);

      const replay = await route.request('/connectors/github/manifest/complete', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ code: 'one-time-code', state: started.state }),
      });
      expect(replay.status).toBe(400);
    } finally {
      await __fixture.clearGitHub();
    }
  });

  test('rejects a duplicate data source name before creating a GitHub App manifest session', async () => {
    const convertManifest = vi.fn();
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { convertManifest });
    await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx.insert(connectorConfigs).values({
        tenantId: __fixture.tenantA,
        name: 'GitHub',
        type: 'github',
        settings: { appId: 'existing' },
        enabled: false,
      }),
    );
    try {
      const response = await route.request('/connectors/github/manifest/start', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          name: 'github',
          ownerType: 'personal',
          deliveryMode: 'smee',
          deliveryUrl: 'https://smee.io/duplicate-name-test',
          dashboardUrl: 'http://localhost:45173',
        }),
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: 'a GitHub data source with this name already exists or is being set up',
      });
      expect(convertManifest).not.toHaveBeenCalled();
      const sessions = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(githubManifestSessions),
      );
      expect(sessions).toEqual([]);
    } finally {
      await __fixture.clearGitHub();
    }
  });

  test('rejects a non-Smee URL when Smee delivery is selected', async () => {
    const route = __fixture.makeConnApp();
    const response = await route.request('/connectors/github/manifest/start', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        ownerType: 'personal',
        deliveryMode: 'smee',
        deliveryUrl: 'https://example.com/not-smee',
        dashboardUrl: 'http://localhost:45173',
      }),
    });
    expect(response.status).toBe(400);
  });

  test('rejects malformed save and discovery bodies without state mutation', async () => {
    const discoverInstallations = vi.fn(async () => []);
    const discoverRepositories = vi.fn(async () => []);
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverInstallations,
      discoverRepositories,
    });
    const cases = [
      ['PUT', '/connectors/github', null],
      ['PUT', '/connectors/github', []],
      ['PUT', '/connectors/github', { settings: {}, credential: 7 }],
      ['POST', '/connectors/github/installations', null],
      ['POST', '/connectors/github/installations', []],
      [
        'POST',
        '/connectors/github/installations',
        { settings: { appId: 'Iv1.test' }, credential: 7 },
      ],
      [
        'POST',
        '/connectors/github/repositories',
        { settings: { appId: 'Iv1.test', installationId: 101 }, credential: 7 },
      ],
    ] as const;

    for (const [method, path, body] of cases) {
      const response = await route.request(path, {
        method,
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
    expect(discoverInstallations).not.toHaveBeenCalled();
    expect(discoverRepositories).not.toHaveBeenCalled();
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'github')),
      ),
    ).toEqual([]);
    expect(
      await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('github')),
    ).toBeNull();
  });

  test('discovers installations and repositories transiently without disclosing or persisting the key', async () => {
    const privateKey = 'write-only-private-key';
    const discoverInstallations = vi.fn(async () => [
      {
        id: 101,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'selected' as const,
        permissions: { deployments: 'read' as const },
        appSlug: 'sre-app',
      },
    ]);
    const discoverRepositories = vi.fn(async () => [
      {
        id: 202,
        owner: 'acme',
        name: 'checkout',
        fullName: 'acme/checkout',
        private: true,
        archived: false,
        webUrl: 'https://github.com/acme/checkout',
      },
    ]);
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverInstallations,
      discoverRepositories,
    });

    const installations = await route.request('/connectors/github/installations', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ settings: { appId: 'Iv1.test' }, credential: privateKey }),
    });
    const repositories = await route.request('/connectors/github/repositories', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: { appId: 'Iv1.test', installationId: 101 },
        credential: privateKey,
      }),
    });
    const text = `${await installations.text()} ${await repositories.text()}`;

    expect([installations.status, repositories.status]).toEqual([200, 200]);
    expect(discoverInstallations).toHaveBeenCalledWith({ appId: 'Iv1.test' }, privateKey);
    expect(discoverRepositories).toHaveBeenCalledWith(
      { appId: 'Iv1.test', installationId: '101' },
      privateKey,
    );
    expect(text).not.toContain(privateKey);
    expect(
      await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'github')),
      ),
    ).toEqual([]);
    expect(
      await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('github')),
    ).toBeNull();
  });

  test('returns and logs a sanitized reason when GitHub rejects App credentials', async () => {
    const privateKey = 'write-only-private-key';
    const log = { info: vi.fn(), error: vi.fn() };
    const discoverInstallations = vi.fn(async () => {
      throw new GitHubInstallationDiscoveryError('credentials_rejected', 401);
    });
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverInstallations,
      log,
    });

    const response = await route.request('/connectors/github/installations', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ settings: { appId: 'Iv1.test' }, credential: privateKey }),
    });
    const body = await response.json();

    expect(response.status).toBe(422);
    expect(body).toEqual({
      error:
        'GitHub rejected this client/App ID and private key. Confirm the key was generated by the same GitHub App.',
      code: 'credentials_rejected',
    });
    expect(log.error).toHaveBeenCalledWith('GitHub installation discovery failed', {
      tenantId: __fixture.tenantA,
      connectorType: 'github',
      operation: 'installation_discovery',
      failureCategory: 'credentials_rejected',
      upstreamStatus: 401,
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(privateKey);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('Iv1.test');
  });

  test('stores the Smee channel encrypted and reconciles the relay without a process restart', async () => {
    const githubSmee = { replace: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { githubSmee });
    const settings = {
      appId: 'Iv1.smee',
      installationId: 101,
      accountLogin: 'acme',
      repositorySelection: 'all',
      permissions: { contents: 'read' },
      eventTransport: 'smee',
    };
    try {
      const saved = await route.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { ...settings, smeeUrl: 'https://smee.io/tenant-channel' },
          credential: 'private-key',
          webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
        }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({ ok: true, relayStatus: 'connected' });
      const stored = await __fixture.activeCredential('github');
      const connector = await __fixture.activeConnector('github');
      expect(githubSmeeUrl(stored!)).toBe('https://smee.io/tenant-channel');
      expect(githubSmee.replace).toHaveBeenCalledWith(
        __fixture.tenantA,
        connector.id,
        'https://smee.io/tenant-channel',
        connector.id,
      );

      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(await listed.text()).not.toContain('tenant-channel');

      const edited = await route.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings }),
      });
      expect(edited.status).toBe(200);
      expect(githubSmeeUrl((await __fixture.activeCredential('github'))!)).toBe(
        'https://smee.io/tenant-channel',
      );

      const direct = await route.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { ...settings, eventTransport: 'direct' } }),
      });
      expect(direct.status).toBe(200);
      expect(await direct.json()).toMatchObject({ relayStatus: 'stopped' });
      expect(githubSmeeUrl((await __fixture.activeCredential('github'))!)).toBe(null);
      expect(githubSmee.stop).toHaveBeenCalledWith(connector.id);
    } finally {
      await route.request('/connectors/github', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      await __fixture.clearGitHub();
    }
  });

  test('stores a disabled split-secret draft, preserves an omitted key, rotates it, and never projects it', async () => {
    const route = __fixture.makeConnApp();
    try {
      const settings = {
        appId: 'Iv1.test',
        installationId: 101,
        repo: 'acme/checkout',
        accountLogin: 'acme',
        repositorySelection: 'selected',
        permissions: {
          deployments: 'write',
          contents: 'read',
          administration: 'write',
        },
      };
      expect(
        (
          await route.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings,
              credential: 'first-private-key',
              webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
            }),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await route.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({ settings: { ...settings, service: 'checkout' } }),
          })
        ).status,
      ).toBe(200);
      const firstSaved = await __fixture.activeCredential('github');
      expect(githubPrivateKey(firstSaved!)).toBe('first-private-key');
      expect(githubWebhookSecret(firstSaved!)).toBe(__fixture.GITHUB_WEBHOOK_SECRET);
      const changedApp = await route.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { ...settings, appId: 'Iv1.changed' } }),
      });
      expect(changedApp.status).toBe(400);
      expect(githubPrivateKey((await __fixture.activeCredential('github'))!)).toBe(
        'first-private-key',
      );
      expect(
        (
          await route.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({ settings, credential: 'rotated-private-key' }),
          })
        ).status,
      ).toBe(200);
      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const text = await listed.text();
      expect(JSON.parse(text)).toMatchObject({
        connectors: [
          {
            type: 'github',
            enabled: false,
            credentialConfigured: true,
            settings: {
              appId: 'Iv1.test',
              installationId: '101',
              repo: 'acme/checkout',
              permissions: { deployments: 'write', contents: 'read' },
            },
          },
        ],
      });
      expect(text).not.toContain('rotated-private-key');
      expect(text).not.toContain(__fixture.GITHUB_WEBHOOK_SECRET);
    } finally {
      await __fixture.clearGitHub();
    }
  });
});
