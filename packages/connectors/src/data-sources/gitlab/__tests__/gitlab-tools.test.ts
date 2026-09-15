import { describe, expect, it, test, vi } from 'vitest';
import {
  cfg,
  jsonRes,
  makeGitLabConnector,
  publicLookup,
  z,
  type IDataSourceConnector,
} from './test-helpers';

/** A fake fetch for the tool tests: routes by a caller-supplied handler, returning a real Response. */
function fakeToolFetch(handler: (url: string) => Response) {
  return (async (url: string) => handler(String(url))) as unknown as typeof fetch;
}

function toolByName(c: IDataSourceConnector, name: string) {
  const t = c.tools().find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

describe('makeGitLabTools', () => {
  it('exposes seven tools', () => {
    const c = makeGitLabConnector(
      cfg({ settings: { projectId: 42 } }),
      fakeToolFetch(() => jsonRes(200, [])),
      publicLookup,
    );
    expect(new Set(c.tools().map((t) => t.name))).toEqual(
      new Set([
        'api_get',
        'get_job_trace',
        'get_pipeline_jobs',
        'list_commits',
        'list_issues',
        'list_merge_requests',
        'list_pipelines',
      ]),
    );
  });

  it('exposes GET-only tools (no method or body in input schema)', () => {
    const c = makeGitLabConnector(
      cfg({ settings: { projectId: 42 } }),
      fakeToolFetch(() => jsonRes(200, [])),
      publicLookup,
    );
    for (const tool of c.tools()) {
      const shape = (tool.inputSchema as z.ZodObject<any>).shape;
      expect(Object.keys(shape)).not.toContain('method');
      expect(Object.keys(shape)).not.toContain('body');
    }
  });

  it('list_pipelines defaults to the configured project and sanitizes nothing benign', async () => {
    let seen = '';
    const fetchImpl = fakeToolFetch((url) => {
      seen = url;
      return jsonRes(200, [
        { id: 1, status: 'failed', sha: 'deadbeef12', ref: 'main', web_url: 'u' },
      ]);
    });
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), fetchImpl, publicLookup);
    const out = (await toolByName(c, 'list_pipelines').run({ status: 'failed' })) as unknown[];
    expect(seen).toContain('/api/v4/projects/42/pipelines');
    expect(seen).toContain('status=failed');
    expect(out).toHaveLength(1);
  });

  it('api_get redacts CI variable values via the sanitizer', async () => {
    const fetchImpl = fakeToolFetch(() => jsonRes(200, [{ key: 'K', value: 'secret' }]));
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), fetchImpl, publicLookup);
    const out = (await toolByName(c, 'api_get').run({
      path: 'projects/42/variables',
    })) as Array<Record<string, unknown>>;
    expect(out[0]!.value).toBe('[REDACTED]');
  });

  it('api_get rejects a host-escaping path', async () => {
    const c = makeGitLabConnector(
      cfg({ settings: { projectId: 42 } }),
      fakeToolFetch(() => jsonRes(200, {})),
      publicLookup,
    );
    await expect(toolByName(c, 'api_get').run({ path: 'https://evil/x' })).rejects.toThrow();
  });

  it('api_get rejects a traversal path', async () => {
    const c = makeGitLabConnector(
      cfg({ settings: { projectId: 42 } }),
      fakeToolFetch(() => jsonRes(200, {})),
      publicLookup,
    );
    await expect(toolByName(c, 'api_get').run({ path: '../../admin' })).rejects.toThrow(
      /\/api\/v4/,
    );
  });

  it('get_job_trace streams a multi-megabyte response and retains only its bounded tail', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      ...Array.from({ length: 24 }, () => encoder.encode('x'.repeat(128 * 1024))),
      encoder.encode('FINAL-TRACE-MARKER'),
    ];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[index];
        index += 1;
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    });
    let requestInit: RequestInit | undefined;
    const fetchImpl = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      requestInit = init;
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }) as typeof fetch;
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), fetchImpl, publicLookup);
    const out = (await toolByName(c, 'get_job_trace').run({ job_id: 9 })) as {
      truncated: boolean;
      body: string;
    };
    expect(out.truncated).toBe(true);
    expect(out.body.length).toBe(64 * 1024);
    expect(out.body.endsWith('FINAL-TRACE-MARKER')).toBe(true);
    const requestHeaders = requestInit?.headers as Record<string, string> | undefined;
    expect(requestHeaders?.['PRIVATE-TOKEN']).toBe('glpat-token');
    expect(requestInit?.signal).toBeDefined();
    expect(requestInit?.redirect).toBe('error');
  });
});

describe('group-scoped GitLab connector', () => {
  const catalog = {
    resolve: async () => [
      {
        repositoryId: '42',
        fullName: 'platform/services/checkout',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://gitlab.example.com/platform/services/checkout',
      },
    ],
    search: async (query: string) =>
      query === 'platform/services/checkout' || query === '42'
        ? [
            {
              repositoryId: '42',
              fullName: 'platform/services/checkout',
              defaultBranch: 'main',
              private: true,
              archived: false,
              htmlUrl: 'https://gitlab.example.com/platform/services/checkout',
            },
          ]
        : [],
    recentEvents: async () => [],
  };

  test('normalizes standalone wildcard enumeration while retaining the bounded catalog call', async () => {
    const search = vi.fn(async () => catalog.resolve());
    const connector = makeGitLabConnector(
      { ...cfg({ settings: { groupId: 7 } }), repositories: { ...catalog, search } },
      fakeToolFetch(() => jsonRes(200, [])),
      publicLookup,
    );
    const result = await toolByName(connector, 'search_projects').run({ query: ' * ', limit: 500 });
    expect(search).toHaveBeenCalledWith('', 50);
    await toolByName(connector, 'search_projects').run({ query: 'api', limit: 2.5 });
    expect(search).toHaveBeenLastCalledWith('api', 2);
    expect(result).toMatchObject([{ repositoryId: '42' }]);
    await expect(
      toolByName(connector, 'list_pipelines').run({ project: 'outside/project' }),
    ).rejects.toThrow(/outside/);
  });

  test('verifies recursive catalog access and representative incident reads', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/user')) return jsonRes(200, { id: 9, username: 'group_7_bot' });
      if (url.includes('/groups/7?')) {
        return jsonRes(200, {
          id: 7,
          name: 'Platform',
          full_path: 'platform',
          web_url: 'https://gitlab.example.com/groups/platform',
        });
      }
      if (url.includes('/groups/7/projects')) {
        return jsonRes(200, [
          {
            id: 42,
            name: 'checkout',
            path_with_namespace: 'platform/services/checkout',
            web_url: 'https://gitlab.example.com/platform/services/checkout',
            default_branch: 'main',
            visibility: 'private',
            archived: false,
          },
        ]);
      }
      return jsonRes(200, []);
    }) as typeof fetch;
    const connector = makeGitLabConnector(
      cfg({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'platform',
          eventTransport: 'none',
        },
        repositories: catalog,
      }),
      fetchImpl,
      publicLookup,
    );

    await expect(connector.snapshot()).resolves.toEqual([]);
    const result = await connector.probe();
    expect(result).toMatchObject({
      status: 'healthy',
      authorized: true,
      checks: {
        canReadGroup: true,
        canEnumerateProjects: true,
        hasProjects: true,
        canReadProject: true,
        canReadCode: true,
        canReadPipelines: true,
        canReadDeployments: true,
      },
      details: { group: 'platform', projectCount: 1, eventSync: 'none' },
    });
  });

  test('refuses tool reads for a project outside the synchronized group catalog', async () => {
    const connector = makeGitLabConnector(
      cfg({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'platform',
        },
        repositories: catalog,
      }),
      fakeToolFetch(() => jsonRes(200, [])),
      publicLookup,
    );

    await expect(
      toolByName(connector, 'list_commits').run({ project: 'another-group/secret' }),
    ).rejects.toThrow(/outside the synchronized group catalog/);
    await expect(
      toolByName(connector, 'list_commits').run({ project: 'platform/services/checkout' }),
    ).resolves.toEqual([]);
  });

  test.each([
    '%2e%2e/%2e%2e/projects',
    '.%2e/.%2e/projects',
    '..\\..\\projects',
    '..%2f..%2fprojects',
    '..%5c..%5cprojects',
  ])('keeps encoded project API paths inside the synchronized project: %s', async (path) => {
    let fetches = 0;
    const connector = makeGitLabConnector(
      cfg({
        settings: {
          baseUrl: 'https://gitlab.example.com',
          groupId: 7,
          groupPath: 'platform',
        },
        repositories: catalog,
      }),
      fakeToolFetch(() => {
        fetches += 1;
        return jsonRes(200, []);
      }),
      publicLookup,
    );

    await expect(
      toolByName(connector, 'api_get').run({
        project: 'platform/services/checkout',
        path,
      }),
    ).rejects.toThrow(/project API path/);
    expect(fetches).toBe(0);
  });
});
