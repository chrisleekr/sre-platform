import { describe, expect, it, vi } from 'vitest';
import {
  PEM,
  type Reply,
  cfg,
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  makeFetch,
  makeGitHubConnector,
  publicLookup,
  withMint,
} from './test-helpers';

describe('GitHub App discovery', () => {
  it('classifies invalid PEM and rejected App credentials without returning provider bodies', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'provider detail must stay private' }), {
          status: 401,
        }),
    ) as unknown as typeof fetch;

    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.split' }, 'not-a-private-key', fetchImpl),
    ).rejects.toMatchObject({
      failureCategory: 'invalid_private_key',
      upstreamStatus: null,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.wrong-app' }, PEM, fetchImpl),
    ).rejects.toMatchObject({
      failureCategory: 'credentials_rejected',
      upstreamStatus: 401,
    });
  });

  it('returns allowlisted installation and repository fields without projecting credentials', async () => {
    const installationFetch = makeFetch((url) => {
      if (url.endsWith('/app')) return { status: 200, json: { slug: 'sre-triage', secret: 'no' } };
      if (url.includes('/app/installations'))
        return {
          status: 200,
          json: [
            {
              id: 101,
              account: { login: 'acme', type: 'Organization', email: 'private@example.com' },
              repository_selection: 'selected',
              permissions: {
                deployments: 'read',
                metadata: 'read',
                contents: 'read',
                administration: 'write',
              },
              access_tokens_url: 'secret-url',
            },
          ],
        };
      return { status: 404 };
    });
    const installations = await discoverGitHubInstallations(
      { appId: 'Iv1.split' },
      PEM,
      installationFetch.fetchImpl,
    );
    expect(installations).toEqual([
      {
        id: 101,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'selected',
        permissions: { deployments: 'read', metadata: 'read', contents: 'read' },
        writePermissions: ['administration'],
        appSlug: 'sre-triage',
      },
    ]);
    expect(JSON.stringify(installations)).not.toContain('private@example.com');
    expect(JSON.stringify(installations)).not.toContain(PEM);

    const repositoryFetch = makeFetch(
      withMint((url) =>
        url.includes('/installation/repositories')
          ? {
              status: 200,
              json: {
                repositories: [
                  {
                    id: 202,
                    name: 'checkout',
                    full_name: 'acme/checkout',
                    private: true,
                    html_url: 'https://github.com/acme/checkout',
                    clone_url: 'https://token@github.com/acme/checkout.git',
                  },
                ],
              },
            }
          : { status: 404 },
      ),
    );
    const repositories = await discoverGitHubRepositories(
      { appId: 'Iv1.split', installationId: 101 },
      PEM,
      repositoryFetch.fetchImpl,
    );
    expect(repositories).toEqual([
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
    expect(JSON.stringify(repositories)).not.toContain('token@');
    expect(
      repositoryFetch.calls.find((call) => call.url.includes('/installation/repositories'))?.url,
    ).toBe('https://api.github.com/installation/repositories?per_page=100');
    expect(repositoryFetch.calls.find((call) => call.url.includes('/access_tokens'))?.body).toBe(
      undefined,
    );
  });

  it('rejects a pagination link that leaves the pinned GitHub origin', async () => {
    const { fetchImpl } = makeFetch((url) =>
      url.endsWith('/app')
        ? { status: 200, json: { slug: 'app' } }
        : {
            status: 200,
            json: [],
            link: '<https://evil.example/installations?page=2>; rel="next"',
          },
    );
    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.split' }, PEM, fetchImpl),
    ).rejects.toMatchObject({ failureCategory: 'invalid_response' });
  });

  it('cancels an unknown-length chunked JSON response after the byte limit', async () => {
    let cancelled = false;
    const chunk = new Uint8Array(600 * 1024).fill(32);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(
      discoverGitHubInstallations(
        { appId: 'Iv1.split' },
        PEM,
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toMatchObject({ failureCategory: 'invalid_response' });
    expect(cancelled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized, repeated, and overlong installation pagination', async () => {
    const oversized = makeFetch((url) =>
      url.endsWith('/app')
        ? { status: 200, json: {} }
        : { status: 200, json: Array.from({ length: 101 }, () => ({})) },
    );
    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.split' }, PEM, oversized.fetchImpl),
    ).rejects.toMatchObject({ failureCategory: 'invalid_response' });

    const repeated = makeFetch((url) => {
      if (url.endsWith('/app')) return { status: 200, json: {} };
      return {
        status: 200,
        json: [{}],
        link: '<https://api.github.com/app/installations?per_page=100&page=2>; rel="next"',
      };
    });
    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.split' }, PEM, repeated.fetchImpl),
    ).rejects.toMatchObject({ failureCategory: 'invalid_response' });

    const overlong = makeFetch((url) => {
      if (url.endsWith('/app')) return { status: 200, json: {} };
      const current = Number(new URL(url).searchParams.get('page') ?? '1');
      return {
        status: 200,
        json: [{}],
        link: `<https://api.github.com/app/installations?per_page=100&page=${current + 1}>; rel="next"`,
      };
    });
    await expect(
      discoverGitHubInstallations({ appId: 'Iv1.split' }, PEM, overlong.fetchImpl),
    ).rejects.toMatchObject({ failureCategory: 'invalid_response' });
  });
});

describe('github tools — requests', () => {
  async function run(
    name: string,
    input: unknown,
    routes: (u: string) => Reply,
    settings?: Record<string, unknown>,
  ) {
    const { fetchImpl, calls } = makeFetch(withMint(routes));
    const c = makeGitHubConnector(cfg(settings), fetchImpl, publicLookup);
    const tool = c.tools().find((t) => t.name === name)!;
    const out = await tool.run(input);
    return { out, calls };
  }

  it('list_commits hits the default repo with auth + version headers', async () => {
    const { calls } = await run(
      'list_commits',
      { since: '2026-07-01T00:00:00Z', per_page: 5 },
      () => ({
        status: 200,
        json: [],
      }),
    );
    const get = calls.find((c) => c.url.includes('/commits'))!;
    expect(get.url).toBe(
      'https://api.github.com/repos/octo/app/commits?since=2026-07-01T00%3A00%3A00Z&per_page=5',
    );
    expect(get.authorization).toBe('Bearer ghs_tok');
    expect(get.accept).toBe('application/vnd.github+json');
    expect(get.apiVersion).toBe('2022-11-28');
    expect(get.redirect).toBe('error');
  });

  it('an explicit repo arg overrides the configured default', async () => {
    const { calls } = await run('list_pull_requests', { repo: 'other/svc', state: 'open' }, () => ({
      status: 200,
      json: [],
    }));
    expect(calls.find((c) => c.url.includes('/pulls'))!.url).toBe(
      'https://api.github.com/repos/other/svc/pulls?state=open&per_page=20',
    );
  });

  it('clamps per_page to [1,100]', async () => {
    const high = await run('list_commits', { per_page: 9999 }, () => ({ status: 200, json: [] }));
    expect(high.calls.find((c) => c.url.includes('/commits'))!.url).toContain('per_page=100');
    const low = await run('list_commits', { per_page: 0 }, () => ({ status: 200, json: [] }));
    expect(low.calls.find((c) => c.url.includes('/commits'))!.url).toContain('per_page=1');
  });

  it('get_pull_request, workflow jobs, and workflow runs build repository-scoped paths', async () => {
    const pr = await run('get_pull_request', { number: 7 }, () => ({ status: 200, json: {} }));
    expect(pr.calls.find((c) => c.url.includes('/pulls/'))!.url).toBe(
      'https://api.github.com/repos/octo/app/pulls/7',
    );
    const jobs = await run('get_workflow_run_jobs', { run_id: 99 }, () => ({
      status: 200,
      json: {},
    }));
    expect(jobs.calls.find((c) => c.url.includes('/jobs'))!.url).toBe(
      'https://api.github.com/repos/octo/app/actions/runs/99/jobs?per_page=100',
    );
    const runs = await run('list_workflow_runs', { status: 'failure', branch: 'main' }, () => ({
      status: 200,
      json: {},
    }));
    expect(runs.calls.find((c) => c.url.includes('/actions/runs'))!.url).toBe(
      'https://api.github.com/repos/octo/app/actions/runs?branch=main&status=failure&per_page=20',
    );
  });

  it('api_get stays inside the selected repository', async () => {
    const { out, calls } = await run(
      'api_get',
      {
        repo: 'octo/app',
        path: 'repos/octo/app/issues',
      },
      () => ({
        status: 200,
        json: { ok: 1 },
      }),
    );
    expect(calls.find((c) => c.url.endsWith('/repos/octo/app/issues'))).toBeTruthy();
    expect(out).toEqual({ ok: 1 });
    const { fetchImpl } = makeFetch(withMint(() => ({ status: 200 })));
    const c = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
    const api = c.tools().find((t) => t.name === 'api_get')!;
    expect(() => api.run({ repo: 'octo/app', path: 'repos/other/service/issues' })).toThrow(
      /stay inside/,
    );
  });

  it('commit, comparison, code-search, and content tools remain repository scoped', async () => {
    const commit = await run('get_commit', { repo: 'octo/app', ref: 'abc123' }, () => ({
      status: 200,
      json: {},
    }));
    expect(commit.calls.some((call) => call.url.endsWith('/repos/octo/app/commits/abc123'))).toBe(
      true,
    );

    const compare = await run(
      'compare_commits',
      { repo: 'octo/app', base: 'good', head: 'bad' },
      () => ({ status: 200, json: {} }),
    );
    expect(
      compare.calls.some((call) => call.url.endsWith('/repos/octo/app/compare/good...bad')),
    ).toBe(true);

    const search = await run('search_code', { repo: 'octo/app', query: 'TimeoutError' }, () => ({
      status: 200,
      json: {},
    }));
    expect(
      search.calls.some(
        (call) =>
          call.url.includes('/search/code') &&
          new URL(call.url).searchParams.get('q') === 'TimeoutError repo:octo/app',
      ),
    ).toBe(true);

    const content = await run(
      'get_content',
      { repo: 'octo/app', path: 'src/index.ts', ref: 'main' },
      () => ({ status: 200, json: {} }),
    );
    expect(
      content.calls.some((call) =>
        call.url.endsWith('/repos/octo/app/contents/src/index.ts?ref=main'),
      ),
    ).toBe(true);
  });

  it('rejects a missing or malformed repo', async () => {
    const { fetchImpl } = makeFetch(withMint(() => ({ status: 200 })));
    const noRepo = makeGitHubConnector(cfg({}), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'list_commits')!;
    await expect(noRepo.run({})).rejects.toThrow(/no repo/);
    const withRepo = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'list_commits')!;
    await expect(withRepo.run({ repo: '../../etc' })).rejects.toThrow(/owner\/name/);
    await expect(withRepo.run({ repo: 'a/b/c' })).rejects.toThrow(/owner\/name/);
  });

  it('mints the token only once across multiple tool calls in a run', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200, json: [] })));
    const c = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
    const commits = c.tools().find((t) => t.name === 'list_commits')!;
    await commits.run({});
    await commits.run({ per_page: 3 });
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1);
  });

  it('a non-ok GET surfaces the status', async () => {
    const { fetchImpl } = makeFetch(withMint(() => ({ status: 404 })));
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'list_commits')!;
    await expect(t.run({})).rejects.toThrow(/github api 404/);
  });
});
