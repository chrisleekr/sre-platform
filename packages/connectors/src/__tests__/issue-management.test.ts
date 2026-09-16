import { describe, expect, test, vi } from 'vitest';
import { makeGitHubConnector } from '../data-sources/github';
import { makeGitLabConnector } from '../data-sources/gitlab';
import { CRED, makeFetch, withMint, v2cfg } from '../data-sources/github/__tests__/test-helpers';
import type { ConnectorConfig } from '../registry';

const repository = {
  repositoryId: '71',
  fullName: 'team/service',
  defaultBranch: 'main',
  private: true,
  archived: false,
  htmlUrl: 'https://github.com/team/service',
};

describe.each(['github', 'gitlab'] as const)('%s issue management', (provider) => {
  function setup(enabled = true, responseStatus = 200) {
    const project = { id: 71, path_with_namespace: 'team/service', archived: false };
    let issue = {
      title: 'Investigate saturation',
      body: 'Read-only checks',
      state: 'open',
      labels: ['ops'],
      assignees: [] as string[],
    };
    const calls: { method: string; url: string; body: any; headers: Headers }[] = [];
    const transport = vi.fn(async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
      const url = String(input);
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      const method = init.method ?? 'GET';
      calls.push({ method, url, body, headers: new Headers(init.headers) });
      if (url.endsWith('/access_tokens'))
        return Response.json(
          { token: 'scoped-issue-token', expires_at: new Date(Date.now() + 60_000).toISOString() },
          { status: 201 },
        );
      if (method === 'GET' && url.endsWith('/api/v4/projects/71')) return Response.json(project);
      if (responseStatus !== 200)
        return Response.json({ message: 'private provider detail' }, { status: responseStatus });
      if (body)
        issue = {
          ...issue,
          ...body,
          body: body.description ?? body.body ?? issue.body,
          state:
            body.state_event === 'close'
              ? 'closed'
              : body.state_event === 'reopen'
                ? 'open'
                : (body.state ?? issue.state),
        };
      const value =
        provider === 'github'
          ? {
              number: 12,
              ...issue,
              labels: issue.labels.map((name) => ({ name })),
              updated_at: '2026-09-13T00:00:00Z',
            }
          : {
              iid: 12,
              title: issue.title,
              description: issue.body,
              state: issue.state === 'open' ? 'opened' : 'closed',
              labels:
                typeof issue.labels === 'string' ? String(issue.labels).split(',') : issue.labels,
              assignees: [],
              updated_at: '2026-09-13T00:00:00Z',
            };
      return Response.json(method === 'GET' && /\/issues\?/.test(url) ? [value] : value, {
        status: method === 'POST' ? 201 : 200,
      });
    });
    const config: ConnectorConfig = {
      id: 'source',
      name: provider,
      tenantId: 'tenant',
      type: provider,
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'team',
        issueManagement: { enabled, repositories: ['team/service'] },
      },
      getCredential: async () => (provider === 'github' ? CRED : 'read-token'),
      getIssueCredential: async () => 'write-token',
      repositories: {
        resolve: async () => [repository],
        search: async () => [repository],
        recentEvents: async () => [],
      },
    };
    const connector =
      provider === 'github'
        ? makeGitHubConnector(config, transport as unknown as typeof fetch, async () => [
            '93.184.216.34',
          ])
        : makeGitLabConnector(config, transport as unknown as typeof fetch, async () => [
            '93.184.216.34',
          ]);
    return { connector, calls, transport, project, issue };
  }

  test('reads, creates, updates, closes and reopens only admitted issues', async () => {
    const { connector, calls } = setup();
    expect(connector.issues).toBeDefined();
    const port = connector.issues!;
    expect(await port.list('team/service', '', 'open')).toMatchObject([{ number: 12 }]);
    expect(await port.get('team/service', 12)).toMatchObject({ title: 'Investigate saturation' });
    expect(
      await port.create('team/service', {
        title: 'Diagnostic follow-up',
        body: 'Evidence and next checks',
      }),
    ).toMatchObject({ number: 12, title: 'Diagnostic follow-up' });
    expect(
      await port.update('team/service', 12, { title: 'Updated follow-up', state: 'closed' }),
    ).toMatchObject({ title: 'Updated follow-up', state: 'closed' });
    expect(await port.update('team/service', 12, { state: 'open' })).toMatchObject({
      state: 'open',
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    if (provider === 'github') {
      const scopes = calls
        .filter((call) => call.url.endsWith('/access_tokens'))
        .map((call) => call.body);
      expect(scopes).toContainEqual({ repository_ids: [71], permissions: { issues: 'write' } });
      expect(scopes).toContainEqual({ repository_ids: [71], permissions: { issues: 'read' } });
    } else {
      expect(
        calls
          .filter((call) => call.method === 'GET' && call.url.includes('/issues'))
          .every((call) => call.headers.get('PRIVATE-TOKEN') === 'read-token'),
      ).toBe(true);
      expect(
        calls
          .filter((call) => call.method !== 'GET')
          .every((call) => call.headers.get('PRIVATE-TOKEN') === 'write-token'),
      ).toBe(true);
    }
  });

  test('lists usable issues when another row is malformed or too large', async () => {
    const { connector, transport, issue } = setup();
    const original = transport.getMockImplementation()!;
    transport.mockImplementation(async (input, init) => {
      const response = await original(input, init);
      if (!/\/issues\?/.test(String(input))) return response;
      const [valid] = (await response.json()) as Record<string, unknown>[];
      const oversized = {
        ...valid,
        [provider === 'github' ? 'body' : 'description']: 'x'.repeat(20_001),
      };
      return Response.json([null, { invalid: true }, oversized, valid]);
    });
    expect(await connector.issues!.list('team/service')).toMatchObject([{ number: 12 }]);
    issue.body = 'x'.repeat(20_001);
    await expect(connector.issues!.get('team/service', 12)).rejects.toThrow(/20,000/);
    await expect(
      connector.issues!.create('team/service', { title: 'Exact response required' }),
    ).rejects.toThrow(/20,000/);
  });

  test('rejects disabled writes and out-of-scope targets before sending a request', async () => {
    const { connector, calls } = setup(false);
    expect(connector.issues).toBeDefined();
    await expect(connector.issues!.create('team/service', { title: 'No' })).rejects.toThrow(
      /enable|enabled/i,
    );
    await expect(connector.issues!.get('other/repo', 12)).rejects.toThrow(/scope|catalog/i);
    expect(calls).toHaveLength(0);
  });

  test('reports rejected writes without leaking provider text or retrying', async () => {
    const { connector, calls } = setup(true, 403);
    expect(connector.issues).toBeDefined();
    await expect(
      connector.issues!.create('team/service', { title: 'Follow-up' }),
    ).rejects.toMatchObject({
      uncertain: false,
      message: expect.stringMatching(/permission|access/i),
    });
    expect(calls.filter((call) => call.url.includes('/issues'))).toHaveLength(1);
  });

  if (provider === 'gitlab') {
    test('rejects comma-containing labels before any provider request', async () => {
      const { connector, calls } = setup();
      expect(() => connector.issues!.validateChanges({ labels: ['needs,review'] })).toThrow(
        /commas/,
      );
      await expect(
        connector.issues!.create('team/service', { title: 'Test', labels: ['needs,review'] }),
      ).rejects.toThrow(/commas/);
      await expect(
        connector.issues!.update('team/service', 12, { labels: ['needs,review'] }),
      ).rejects.toThrow(/commas/);
      expect(calls).toHaveLength(0);
      expect(() =>
        connector.issues!.validateChanges({ labels: ['needs review', 'ops'] }),
      ).not.toThrow();
    });

    test.each([{ id: 72 }, { path_with_namespace: 'outside/service' }, { archived: true }])(
      'rejects live project changes despite an unchanged catalog: %j',
      async (change) => {
        const { connector, calls, project } = setup();
        Object.assign(project, change);
        await expect(
          connector.issues!.create('team/service', { title: 'Do not publish' }),
        ).rejects.toThrow(/project changed or is archived/);
        await expect(
          connector.issues!.update('team/service', 12, { state: 'closed' }),
        ).rejects.toThrow(/project changed or is archived/);
        expect(calls.every((call) => call.method === 'GET')).toBe(true);
        expect(calls.every((call) => call.headers.get('PRIVATE-TOKEN') === 'write-token')).toBe(
          true,
        );
      },
    );

    test.each([
      '/move outside/project',
      '/clone outside/project --with_notes',
      '/create_merge_request branch',
      '/cl\rone outside/project',
    ])('blocks provider quick actions at the adapter boundary: %s', async (body) => {
      const { connector, calls } = setup();
      await expect(
        connector.issues!.create('team/service', { title: 'No command execution', body }),
      ).rejects.toThrow(/quick actions/);
      expect(calls).toHaveLength(0);
    });
  }
});

test.each([
  { enabled: true, otherWrite: false, healthy: true, issuePermission: 'write' },
  { enabled: true, otherWrite: false, healthy: false, issuePermission: 'read' },
  { enabled: true, otherWrite: false, healthy: false, issuePermission: undefined },
  { enabled: false, otherWrite: false, healthy: true, issuePermission: 'read' },
  { enabled: false, otherWrite: false, healthy: false, issuePermission: 'write' },
  { enabled: true, otherWrite: true, healthy: false, issuePermission: 'write' },
])(
  'GitHub probe enforces issue-only opt-in: $enabled, issues: $issuePermission, other write: $otherWrite',
  async ({ enabled, otherWrite, healthy, issuePermission }) => {
    const { fetchImpl, calls } = makeFetch(
      withMint(
        (url) =>
          url.includes('/installation/repositories')
            ? { status: 200, json: { repositories: [{ id: 71, full_name: 'team/service' }] } }
            : { status: 404 },
        {
          contents: 'read',
          deployments: 'read',
          ...(issuePermission ? { issues: issuePermission as 'read' | 'write' } : {}),
          ...(otherWrite ? { administration: 'write' as const } : {}),
        },
      ),
    );
    const connector = makeGitHubConnector(
      v2cfg({ issueManagement: { enabled, repositories: ['team/service'] } }),
      fetchImpl,
      async () => ['93.184.216.34'],
    );
    const probe = await connector.probe();
    expect(probe.status).toBe(healthy ? 'healthy' : 'unhealthy');
    expect(probe.checks?.readOnlyApp).toBe(!otherWrite && issuePermission !== 'write');
    if (enabled && issuePermission !== 'write')
      expect(probe.warnings.join(' ')).toContain('requires Issues write permission');
    expect(
      calls
        .filter((call) => call.body)
        .map((call) => JSON.parse(call.body!))
        .every((body) => Object.values(body.permissions).every((value) => value === 'read')),
    ).toBe(true);
  },
);
