import { describe, expect, test, vi } from 'vitest';

import { and, eq, isNull } from 'drizzle-orm';

import {
  connectorConfigs,
  connectorCredentialKey,
  countGitLabProjects,
  gitlabEvents,
  gitlabProjects,
  tenantSecrets,
  withTenant,
  type SecretStore,
} from '@sre/db';

import {
  ConnectorRegistry,
  GitLabDiscoveryError,
  gitLabAccessToken,
  stubConnector,
} from '@sre/connectors';

import { registerTestConnector } from './connector-registry';

import { createFixture } from './connectors.fixture';

const __fixture = createFixture();

describe('GitLab project discovery', () => {
  test('returns safe actionable diagnostics with a reference and no credentials', async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const route = __fixture.makeConnApp(
      fetch,
      async () => {
        throw new GitLabDiscoveryError('not_found', 'group', 404);
      },
      __fixture.secrets,
      { log },
    );
    const response = await route.request('/connectors/gitlab/projects', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: { baseUrl: 'https://gitlab.example.com' },
        credential: 'do-not-return',
      }),
    });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { reference: string; error: string };
    expect(body).toMatchObject({ code: 'not_found', stage: 'group' });
    expect(body.reference).toMatch(/^[a-f0-9-]{36}$/);
    expect(body.error).toContain('Personal namespaces are not groups');
    expect(JSON.stringify(body)).not.toContain('do-not-return');
    expect(log.error).toHaveBeenCalledWith('GitLab discovery failed', {
      tenantId: __fixture.tenantA,
      reference: body.reference,
      failureCategory: 'not_found',
      stage: 'group',
      upstreamStatus: 404,
    });
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('do-not-return');
  });
  test.each([
    ['PUT', '/connectors/gitlab', null],
    ['PUT', '/connectors/gitlab', []],
    ['PUT', '/connectors/gitlab', 'primitive'],
    [
      'PUT',
      '/connectors/gitlab',
      {
        settings: { baseUrl: 'https://gitlab.example.com', projectId: 71 },
        credential: 123,
      },
    ],
    ['POST', '/connectors/gitlab/projects', null],
    ['POST', '/connectors/gitlab/projects', []],
    ['POST', '/connectors/gitlab/projects', 'primitive'],
    [
      'POST',
      '/connectors/gitlab/projects',
      { settings: { baseUrl: 'https://gitlab.example.com' }, credential: 123 },
    ],
  ] as const)('rejects malformed %s %s bodies without mutation', async (method, path, body) => {
    const discover = vi.fn(async () => []);
    const route = __fixture.makeConnApp(fetch, discover);

    const response = await route.request(path, {
      method,
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(discover).not.toHaveBeenCalled();
    const configs = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'gitlab')),
    );
    expect(configs).toEqual([]);
    expect(
      await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('gitlab')),
    ).toBeNull();
  });

  test('is transient: a failed read returns no token and persists no connector or secret', async () => {
    const token = 'glpat-transient-discovery-only';
    const discover = vi.fn(async (_settings: Record<string, unknown>, credential: string) => {
      expect(credential).toBe(token);
      throw new Error(`provider rejected ${credential}`);
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const discoveryApi = __fixture.makeConnApp(fetch, discover);

    const response = await discoveryApi.request('/connectors/gitlab/projects', {
      method: 'POST',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({
        settings: { baseUrl: 'https://gitlab.example.com' },
        credential: token,
      }),
    });
    const responseText = await response.text();
    const configs = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
      tx.select().from(connectorConfigs).where(eq(connectorConfigs.type, 'gitlab')),
    );

    expect(response.status).toBe(502);
    expect(responseText).not.toContain(token);
    expect(configs).toEqual([]);
    expect(
      await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('gitlab')),
    ).toBeNull();
    expect(consoleError.mock.calls.flat().join(' ')).not.toContain(token);
    consoleError.mockRestore();
  });

  test('reuses a stored token only for the saved normalized origin', async () => {
    const discover = vi.fn(async () => []);
    const discoveryApi = __fixture.makeConnApp(fetch, discover);
    const savedSettings = {
      baseUrl: 'https://gitlab.saved.example.com',
      projectId: 71,
      service: 'checkout',
    };
    try {
      const save = await discoveryApi.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: savedSettings, credential: 'stored-origin-token' }),
      });
      expect(save.status).toBe(200);

      const sameOrigin = await discoveryApi.request('/connectors/gitlab/projects', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { baseUrl: `${savedSettings.baseUrl}/` } }),
      });
      expect(sameOrigin.status).toBe(200);
      expect(discover).toHaveBeenLastCalledWith(
        { baseUrl: savedSettings.baseUrl },
        'stored-origin-token',
      );
      discover.mockClear();

      const changedDiscovery = await discoveryApi.request('/connectors/gitlab/projects', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { baseUrl: 'https://gitlab.changed.example.com' } }),
      });
      const changedEdit = await discoveryApi.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { ...savedSettings, baseUrl: 'https://gitlab.changed.example.com' },
        }),
      });

      expect(changedDiscovery.status).toBe(400);
      expect(changedEdit.status).toBe(400);
      expect(discover).not.toHaveBeenCalled();
      const rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ settings: connectorConfigs.settings })
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.type, 'gitlab'), isNull(connectorConfigs.deletedAt))),
      );
      expect(rows[0]?.settings).toEqual(savedSettings);
      expect(await __fixture.activeCredential('gitlab')).toBe('stored-origin-token');
    } finally {
      await discoveryApi.request('/connectors/gitlab', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('serializes concurrent GitLab edits and leaves config and credential from the last request', async () => {
    const route = __fixture.makeConnApp();
    const original = {
      baseUrl: 'https://gitlab.serial.example.com',
      projectId: 71,
      service: 'original',
    };
    const seed = await route.request('/connectors/gitlab', {
      method: 'PUT',
      headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      body: JSON.stringify({ settings: original, credential: 'original-token' }),
    });
    expect(seed.status).toBe(200);

    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let gateNextRead = true;
    const gatedSecrets: SecretStore = {
      ...__fixture.secrets,
      get: async (...args) => {
        if (gateNextRead) {
          gateNextRead = false;
          enteredFirst();
          await firstRelease;
        }
        return __fixture.secrets.get(...args);
      },
    };
    const concurrentApi = __fixture.makeConnApp(fetch, undefined, gatedSecrets);
    try {
      const first = concurrentApi.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({ settings: { ...original, service: 'first' } }),
      });
      await firstEntered;
      let secondSettled = false;
      const second = Promise.resolve(
        concurrentApi.request('/connectors/gitlab', {
          method: 'PUT',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          body: JSON.stringify({
            settings: {
              baseUrl: 'https://gitlab.second.example.com',
              projectId: 72,
              service: 'second',
            },
            credential: 'second-token',
          }),
        }),
      ).finally(() => {
        secondSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondSettled).toBe(false);

      releaseFirst();
      const [firstResponse, secondResponse] = await Promise.all([first, second]);
      expect([firstResponse.status, secondResponse.status]).toEqual([200, 200]);
      const rows = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select({ settings: connectorConfigs.settings })
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.type, 'gitlab'), isNull(connectorConfigs.deletedAt))),
      );
      expect(rows[0]?.settings).toEqual({
        baseUrl: 'https://gitlab.second.example.com',
        projectId: 72,
        service: 'second',
      });
      expect(await __fixture.activeCredential('gitlab')).toBe('second-token');
    } finally {
      releaseFirst();
      await route.request('/connectors/gitlab', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('persists and returns a secret-free GitLab verification failure category', async () => {
    const rateLimitedFetch = (async () =>
      new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const route = __fixture.makeConnApp(rateLimitedFetch);
    try {
      const save = await route.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: {
            baseUrl: 'https://gitlab.rate-limited.example.com',
            projectId: 71,
          },
          credential: 'rate-limited-token',
        }),
      });
      expect(save.status).toBe(200);
      const tested = await route.request('/connectors/gitlab/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({
        status: 'unhealthy',
        failureCategory: 'rate_limited',
        enabled: false,
      });

      const listed = await route.request('/connectors', {
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      const text = await listed.text();
      expect(JSON.parse(text)).toMatchObject({
        connectors: [
          {
            type: 'gitlab',
            verification: { failureCategory: 'rate_limited' },
          },
        ],
      });
      expect(text).not.toContain('rate-limited-token');
    } finally {
      await route.request('/connectors/gitlab', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });

  test('serializes changed-origin discovery behind disconnect across independent routers', async () => {
    let releaseDelete!: () => void;
    let enteredDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => {
      enteredDelete = resolve;
    });
    const deleteRelease = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    let gateDelete = false;
    const gatedSecrets: SecretStore = {
      ...__fixture.secrets,
      delete: async (...args) => {
        if (gateDelete) {
          enteredDelete();
          await deleteRelease;
        }
        return __fixture.secrets.delete(...args);
      },
    };
    const discover = vi.fn(async () => []);
    const disconnectApp = __fixture.makeConnApp(fetch, discover, gatedSecrets);
    const discoveryApp = __fixture.makeConnApp(fetch, discover, gatedSecrets);
    try {
      const saved = await disconnectApp.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: {
            baseUrl: 'https://gitlab.saved.example.com',
            projectId: 71,
            service: 'checkout',
          },
          credential: 'cross-instance-token',
        }),
      });
      expect(saved.status).toBe(200);

      gateDelete = true;
      const disconnect = Promise.resolve(
        disconnectApp.request('/connectors/gitlab', {
          method: 'DELETE',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        }),
      );
      await deleteEntered;
      let discoverySettled = false;
      const changedOriginDiscovery = Promise.resolve(
        discoveryApp.request('/connectors/gitlab/projects', {
          method: 'POST',
          headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
          body: JSON.stringify({
            settings: { baseUrl: 'https://gitlab.changed.example.com' },
          }),
        }),
      ).finally(() => {
        discoverySettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(discoverySettled).toBe(false);

      releaseDelete();
      const [disconnectResponse, discoveryResponse] = await Promise.all([
        disconnect,
        changedOriginDiscovery,
      ]);
      expect(disconnectResponse.status).toBe(200);
      expect(discoveryResponse.status).toBe(400);
      expect(discover).not.toHaveBeenCalled();
      const configs = await withTenant(__fixture.app.db, __fixture.tenantA, (tx) =>
        tx
          .select()
          .from(connectorConfigs)
          .where(and(eq(connectorConfigs.type, 'gitlab'), isNull(connectorConfigs.deletedAt))),
      );
      expect(configs).toEqual([]);
      expect(
        await __fixture.secrets.get(__fixture.tenantA, connectorCredentialKey('gitlab')),
      ).toBeNull();
    } finally {
      releaseDelete();
      await __fixture.admin.db
        .delete(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.tenantId, __fixture.tenantA),
            eq(connectorConfigs.type, 'gitlab'),
          ),
        );
      await __fixture.admin.db
        .delete(tenantSecrets)
        .where(
          and(
            eq(tenantSecrets.tenantId, __fixture.tenantA),
            eq(tenantSecrets.name, connectorCredentialKey('gitlab')),
          ),
        );
    }
  });

  test('discovers, saves, verifies, and catalogs one GitLab group without a project selection', async () => {
    const discovery = {
      group: {
        id: 7,
        name: 'Platform',
        fullPath: 'platform',
        webUrl: 'https://gitlab.example.com/groups/platform',
      },
      projects: [
        {
          id: 41,
          name: 'checkout',
          pathWithNamespace: 'platform/checkout',
          webUrl: 'https://gitlab.example.com/platform/checkout',
          defaultBranch: 'main',
          visibility: 'private',
          archived: false,
        },
        {
          id: 42,
          name: 'orders',
          pathWithNamespace: 'platform/services/orders',
          webUrl: 'https://gitlab.example.com/platform/services/orders',
          defaultBranch: 'main',
          visibility: 'private',
          archived: false,
        },
      ],
    };
    const discoverGroup = vi.fn(async () => discovery);
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'gitlab', (config) => ({
      ...stubConnector('gitlab', config),
      probe: async () => ({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: [],
        checks: {
          canReadGroup: true,
          canEnumerateProjects: true,
          hasProjects: true,
          canReadProject: true,
          canReadCode: true,
          canReadPipelines: true,
          canReadDeployments: true,
        },
      }),
    }));
    const route = __fixture.makeConnApp(fetch, undefined, __fixture.secrets, {
      discoverGroup,
      registry,
    });
    try {
      const discovered = await route.request('/connectors/gitlab/projects', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: { baseUrl: 'https://gitlab.example.com', groupPath: 'platform' },
          credential: 'group-token',
        }),
      });
      expect(discovered.status).toBe(200);
      expect(await discovered.json()).toEqual(discovery);

      const saved = await route.request('/connectors/gitlab', {
        method: 'PUT',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
        body: JSON.stringify({
          settings: {
            baseUrl: 'https://gitlab.example.com',
            groupId: 7,
            groupPath: 'platform',
            groupName: 'Platform',
            eventTransport: 'none',
          },
          credential: 'group-token',
        }),
      });
      expect(saved.status).toBe(200);
      const savedBody = (await saved.json()) as { connectorId: string };
      expect(savedBody).toMatchObject({
        ok: true,
        webhookPath: expect.stringMatching(/^\/webhooks\/gitlab\//),
      });

      const tested = await route.request('/connectors/gitlab/test', {
        method: 'POST',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toMatchObject({
        status: 'healthy',
        enabled: true,
        details: { projectCount: 2 },
      });
      expect(
        await countGitLabProjects(__fixture.app.db, __fixture.tenantA, savedBody.connectorId),
      ).toBe(2);
      expect(
        gitLabAccessToken(
          (await __fixture.secrets.get(
            __fixture.tenantA,
            connectorCredentialKey(savedBody.connectorId),
          ))!,
        ),
      ).toBe('group-token');
      expect(discoverGroup).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 7, groupPath: 'platform' }),
        'group-token',
      );
    } finally {
      await __fixture.admin.db
        .delete(gitlabEvents)
        .where(eq(gitlabEvents.tenantId, __fixture.tenantA));
      await __fixture.admin.db
        .delete(gitlabProjects)
        .where(eq(gitlabProjects.tenantId, __fixture.tenantA));
      await route.request('/connectors/gitlab', {
        method: 'DELETE',
        headers: __fixture.bearer(await __fixture.sign(__fixture.orgA)),
      });
    }
  });
});
