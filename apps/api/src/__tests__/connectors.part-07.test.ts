import { describe, expect, test, vi } from 'vitest';

import { and, eq, isNull } from 'drizzle-orm';

import { connectorConfigs, connectorCredentialKey, withTenant, type SecretStore } from '@sre/db';

import {
  ConnectorRegistry,
  githubPrivateKey,
  githubWebhookSecret,
  stubConnector,
} from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('GitHub App connector lifecycle', () => {
  test('upgrades a legacy credential with a webhook secret, synchronizes the catalog, and records health evidence', async () => {
    const legacy = JSON.stringify({
      appId: 'Iv1.legacy',
      installationId: 303,
      privateKey: 'legacy-private-key',
    });
    await withTenant(__fixture.app.db, __fixture.tenantA, async (tx) => {
      const [connector] = await tx
        .insert(connectorConfigs)
        .values({
          tenantId: __fixture.tenantA,
          name: 'Legacy GitHub',
          type: 'github',
          settings: { repo: 'acme/legacy' },
          enabled: false,
        })
        .returning({ id: connectorConfigs.id });
      await __fixture.secrets.put(
        __fixture.tenantA,
        connectorCredentialKey(connector!.id),
        legacy,
        tx,
      );
    });
    const resetAt = '2026-08-22T10:00:00.000Z';
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: __fixture.githubRegistry({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: ['optional Actions read permission is missing'],
        checks: { canReadRepository: true, canReadDeployments: true, canReadActions: false },
        durationMs: 42,
        rateLimitRemaining: 4900,
        rateLimitResetAt: resetAt,
      }),
      discoverRepositories: async () => [
        {
          id: 303,
          owner: 'acme',
          name: 'legacy',
          fullName: 'acme/legacy',
          private: true,
          archived: false,
          webUrl: 'https://github.com/acme/legacy',
        },
      ],
    });
    try {
      const upgraded = await route.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { appId: 'Iv1.legacy', installationId: 303, repo: 'acme/legacy' },
          webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
        }),
      });
      expect(upgraded.status).toBe(200);
      const response = await route.request('/connectors/github/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'healthy', enabled: true });
      const saved = await __fixture.activeCredential('github');
      expect(githubPrivateKey(saved!)).toBe('legacy-private-key');
      expect(githubWebhookSecret(saved!)).toBe(__fixture.GITHUB_WEBHOOK_SECRET);
      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const text = await listed.text();
      expect(JSON.parse(text)).toMatchObject({
        connectors: [
          {
            type: 'github',
            enabled: true,
            settings: {
              appId: 'Iv1.legacy',
              installationId: '303',
              repo: 'acme/legacy',
            },
            verification: {
              durationMs: 42,
              rateLimit: { remaining: 4900, resetAt },
            },
          },
        ],
      });
      expect(text).not.toContain('legacy-private-key');
    } finally {
      await __fixture.clearGitHub();
    }
  });

  test('releases the database transaction before discovery provider I/O', async () => {
    let entered!: () => void;
    let release!: () => void;
    const providerEntered = new Promise<void>((resolve) => (entered = resolve));
    const providerRelease = new Promise<void>((resolve) => (release = resolve));
    const discoverInstallations = vi.fn(async () => {
      entered();
      await providerRelease;
      return [];
    });
    const first = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverInstallations,
    });
    const second = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverInstallations,
    });
    const settings = { appId: 'Iv1.race', installationId: 404, repo: 'acme/race' };
    try {
      expect(
        (
          await first.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings,
              credential: 'race-private-key',
              webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
            }),
          })
        ).status,
      ).toBe(200);
      const discovery = first.request('/connectors/github/installations', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { appId: settings.appId } }),
      });
      await providerEntered;
      let disconnected = false;
      const disconnect = Promise.resolve(
        second.request('/connectors/github', {
          method: 'DELETE',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        }),
      ).finally(() => (disconnected = true));
      const disconnectResponse = await disconnect;
      expect(disconnectResponse.status).toBe(200);
      expect(disconnected).toBe(true);
      release();
      expect((await discovery).status).toBe(200);
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('github')),
      ).toBeNull();
      expect(
        await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
          tx
            .select()
            .from(connectorConfigs)
            .where(and(eq(connectorConfigs.type, 'github'), isNull(connectorConfigs.deletedAt))),
        ),
      ).toEqual([]);
    } finally {
      release();
      await __fixture.clearGitHub();
    }
  });

  test('a stale probe cannot overwrite a concurrent edit from another router', async () => {
    let entered!: () => void;
    let release!: () => void;
    const probeEntered = new Promise<void>((resolve) => (entered = resolve));
    const probeRelease = new Promise<void>((resolve) => (release = resolve));
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'github', (config) => ({
      ...stubConnector('github', config),
      probe: async () => {
        entered();
        await probeRelease;
        return {
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
        };
      },
    }));
    const testingRoute = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { registry });
    const editingRoute = __fixture.makeConnApp();
    const original = { appId: 'Iv1.original', installationId: 601, repo: 'acme/original' };
    try {
      expect(
        (
          await editingRoute.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings: original,
              credential: 'original-private-key',
              webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
            }),
          })
        ).status,
      ).toBe(200);
      const staleProbe = testingRoute.request('/connectors/github/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      await probeEntered;
      const replacement = {
        appId: 'Iv1.replacement',
        installationId: 602,
        repo: 'acme/replacement',
      };
      const edited = await editingRoute.request('/connectors/github', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: replacement,
          credential: 'replacement-private-key',
          webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
        }),
      });
      expect(edited.status).toBe(200);
      release();
      expect((await staleProbe).status).toBe(409);

      const [row] = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ settings: connectorConfigs.settings, enabled: connectorConfigs.enabled })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.type, 'github')),
      );
      expect(row).toMatchObject({
        settings: { ...replacement, installationId: '602' },
        enabled: false,
      });
      expect(githubPrivateKey((await __fixture.activeCredential('github'))!)).toBe(
        'replacement-private-key',
      );
    } finally {
      release();
      await __fixture.clearGitHub();
    }
  });

  test('a slower verification cannot overwrite a newer verification from another router', async () => {
    let staleEntered!: () => void;
    let releaseStale!: () => void;
    let currentEntered!: () => void;
    let releaseCurrent!: () => void;
    const staleStarted = new Promise<void>((resolve) => (staleEntered = resolve));
    const staleRelease = new Promise<void>((resolve) => (releaseStale = resolve));
    const currentStarted = new Promise<void>((resolve) => (currentEntered = resolve));
    const currentRelease = new Promise<void>((resolve) => (releaseCurrent = resolve));
    const staleRegistry = new ConnectorRegistry();
    registerTestConnector(staleRegistry, 'github', (config) => ({
      ...stubConnector('github', config),
      probe: async () => {
        staleEntered();
        await staleRelease;
        return {
          status: 'unhealthy' as const,
          reachable: true,
          authorized: false,
          warnings: ['stale result'],
          failureCategory: 'permission_denied' as const,
        };
      },
    }));
    const currentRegistry = new ConnectorRegistry();
    registerTestConnector(currentRegistry, 'github', (config) => ({
      ...stubConnector('github', config),
      probe: async () => {
        currentEntered();
        await currentRelease;
        return {
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
        };
      },
    }));
    const staleRoute = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: staleRegistry,
    });
    const currentRoute = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      registry: currentRegistry,
      discoverRepositories: async () => [
        {
          id: 604,
          owner: 'acme',
          name: 'verify',
          fullName: 'acme/verify',
          private: true,
          archived: false,
          webUrl: 'https://github.com/acme/verify',
        },
      ],
    });
    try {
      expect(
        (
          await currentRoute.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings: { appId: 'Iv1.verify', installationId: 604, repo: 'acme/verify' },
              credential: 'verify-private-key',
              webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
            }),
          })
        ).status,
      ).toBe(200);

      const stale = staleRoute.request('/connectors/github/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      await staleStarted;
      const current = currentRoute.request('/connectors/github/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      await currentStarted;

      releaseCurrent();
      expect((await current).status).toBe(200);
      releaseStale();
      expect((await stale).status).toBe(409);

      const [row] = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ enabled: connectorConfigs.enabled, version: connectorConfigs.lifecycleVersion })
          .from(connectorConfigs)
          .where(eq(connectorConfigs.type, 'github')),
      );
      expect(row).toEqual({ enabled: true, version: 1 });
    } finally {
      releaseCurrent();
      releaseStale();
      await __fixture.clearGitHub();
    }
  });

  test('a stale probe cannot recreate a connector disconnected by another router', async () => {
    let entered!: () => void;
    let release!: () => void;
    const probeEntered = new Promise<void>((resolve) => (entered = resolve));
    const probeRelease = new Promise<void>((resolve) => (release = resolve));
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'github', (config) => ({
      ...stubConnector('github', config),
      probe: async () => {
        entered();
        await probeRelease;
        return {
          status: 'healthy' as const,
          reachable: true,
          authorized: true,
          warnings: [],
        };
      },
    }));
    const testingRoute = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, { registry });
    const disconnectingRoute = __fixture.makeConnApp();
    try {
      expect(
        (
          await disconnectingRoute.request('/connectors/github', {
            method: 'PUT',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
            body: JSON.stringify({
              settings: { appId: 'Iv1.disconnect', installationId: 603, repo: 'acme/disconnect' },
              credential: 'disconnect-private-key',
              webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
            }),
          })
        ).status,
      ).toBe(200);
      const staleProbe = testingRoute.request('/connectors/github/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      await probeEntered;
      expect(
        (
          await disconnectingRoute.request('/connectors/github', {
            method: 'DELETE',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          })
        ).status,
      ).toBe(200);
      release();
      expect((await staleProbe).status).toBe(409);
      expect(
        await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
          tx
            .select()
            .from(connectorConfigs)
            .where(and(eq(connectorConfigs.type, 'github'), isNull(connectorConfigs.deletedAt))),
        ),
      ).toEqual([]);
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('github')),
      ).toBeNull();
    } finally {
      release();
      await __fixture.clearGitHub();
    }
  });

  test('rolls back a failed secret-first disconnect and remains retryable and idempotent', async () => {
    const route = __fixture.makeConnApp();
    const saved = await route.request('/connectors/github', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: { appId: 'Iv1.delete', installationId: 505, repo: 'acme/delete' },
        credential: 'delete-private-key',
        webhookSecret: __fixture.GITHUB_WEBHOOK_SECRET,
      }),
    });
    expect(saved.status).toBe(200);
    const failingSecrets: SecretStore = {
      ...__fixture.secrets,
      delete: async () => {
        throw new Error('secret store unavailable');
      },
    };
    const failingRoute = __fixture.makeConnApp(fetch, undefined, failingSecrets);
    try {
      const failed = await failingRoute.request('/connectors/github', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(failed.status).toBe(503);
      expect(githubPrivateKey((await __fixture.activeCredential('github'))!)).toBe(
        'delete-private-key',
      );
      expect(
        await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
          tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'github')),
        ),
      ).toHaveLength(1);

      expect(
        (
          await route.request('/connectors/github', {
            method: 'DELETE',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await route.request('/connectors/github', {
            method: 'DELETE',
            headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          })
        ).status,
      ).toBe(200);
    } finally {
      await __fixture.clearGitHub();
    }
  });
});
