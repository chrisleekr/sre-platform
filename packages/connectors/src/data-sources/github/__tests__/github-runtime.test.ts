import { describe, expect, it, vi } from 'vitest';
import {
  cfg,
  FUTURE,
  makeFetch,
  makeGitHubConnector,
  publicLookup,
  response,
  v2cfg,
  withMint,
  type HostLookup,
  type Reply,
} from './test-helpers';
import { abortableFetch, expectCancelledInFlight } from '../../../__tests__/request-signal.fixture';

describe('get_job_logs — redirect handling', () => {
  function logsRoutes(location: string | undefined, blob: Reply) {
    return withMint((url) => {
      if (url.endsWith('/logs')) return location ? { status: 302, location } : { status: 302 };
      if (url.startsWith('https://blob.example.com/')) return blob;
      return { status: 404 };
    });
  }

  it('follows the 302 to the blob, strips auth, and bounds the body', async () => {
    const { fetchImpl, calls } = makeFetch(
      logsRoutes('https://blob.example.com/signed?sig=x', {
        status: 200,
        text: 'step1\nstep2 FAILED',
      }),
    );
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    expect(await t.run({ job_id: 5 })).toEqual({ truncated: false, body: 'step1\nstep2 FAILED' });
    const logsCall = calls.find((c) => c.url.endsWith('/logs'))!;
    expect(logsCall.redirect).toBe('manual');
    expect(logsCall.authorization).toBe('Bearer ghs_tok');
    const blobCall = calls.find((c) => c.url.startsWith('https://blob.example.com/'))!;
    expect(blobCall.authorization).toBeUndefined(); // token must NOT leak off-host
  });

  it('truncates to the last 64K characters', async () => {
    const big = 'A'.repeat(70_000);
    const { fetchImpl } = makeFetch(
      logsRoutes('https://blob.example.com/x', { status: 200, text: big }),
    );
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    const out = (await t.run({ job_id: 1 })) as { truncated: boolean; body: string };
    expect(out.truncated).toBe(true);
    expect(out.body).toHaveLength(64 * 1024);
  });

  it('rejects a redirect with no Location', async () => {
    const { fetchImpl } = makeFetch(logsRoutes(undefined, { status: 200, text: '' }));
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    await expect(t.run({ job_id: 1 })).rejects.toThrow(/no Location/);
  });

  it('refuses an SSRF Location that resolves to a private host', async () => {
    const { fetchImpl } = makeFetch(
      logsRoutes('https://internal.example.com/x', { status: 200, text: 'x' }),
    );
    const privateLookup: HostLookup = async () => ['127.0.0.1'];
    const t = makeGitHubConnector(cfg(), fetchImpl, privateLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    await expect(t.run({ job_id: 1 })).rejects.toThrow(/not allowed/);
  });

  it('returns a direct 200 body without a blob hop', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint((url) =>
        url.endsWith('/logs') ? { status: 200, text: 'inline log' } : { status: 404 },
      ),
    );
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    expect(await t.run({ job_id: 3 })).toEqual({ truncated: false, body: 'inline log' });
    expect(calls.some((c) => c.url.startsWith('https://blob'))).toBe(false);
  });

  it('surfaces a non-ok status on the logs endpoint itself', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) => (url.endsWith('/logs') ? { status: 500 } : { status: 404 })),
    );
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    await expect(t.run({ job_id: 1 })).rejects.toThrow(/github api 500/);
  });

  it('surfaces a non-ok blob fetch', async () => {
    const { fetchImpl } = makeFetch(logsRoutes('https://blob.example.com/x', { status: 500 }));
    const t = makeGitHubConnector(cfg(), fetchImpl, publicLookup)
      .tools()
      .find((t) => t.name === 'get_job_logs')!;
    await expect(t.run({ job_id: 1 })).rejects.toThrow(/logs blob 500/);
  });
});

describe('fetchTriageContext', () => {
  it('resolves incident repositories from the catalog and correlates synchronized events', async () => {
    const resolve = vi.fn(async () => [
      {
        repositoryId: '202',
        fullName: 'acme/checkout',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://github.com/acme/checkout',
        source: 'mapping',
        confirmed: false,
      },
    ]);
    const recentEvents = vi.fn(async () => [
      {
        eventType: 'push',
        action: null,
        repositoryFullName: 'acme/checkout',
        actor: 'octocat',
        ref: 'refs/heads/main',
        sha: 'abc123',
        summary: { commitCount: 1 },
        occurredAt: new Date('2026-08-23T00:00:00Z'),
      },
    ]);
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url.includes('/commits')) return { status: 200, json: [] };
        if (url.includes('/actions/runs')) return { status: 200, json: { workflow_runs: [] } };
        return { status: 404 };
      }),
    );
    const connector = makeGitHubConnector(
      {
        ...v2cfg(),
        repositories: {
          resolve,
          search: async () => [],
          recentEvents,
        },
      },
      fetchImpl,
      publicLookup,
    );

    const context = await connector.fetchTriageContext({
      service: 'checkout',
      windowMinutes: 60,
    });
    expect(resolve).toHaveBeenCalledWith('checkout');
    expect(recentEvents).toHaveBeenCalledWith(['acme/checkout'], expect.any(Date), 20);
    expect(context.data).toMatchObject({
      service: 'checkout',
      repositories: [
        {
          repo: 'acme/checkout',
          mapping: { source: 'mapping' },
          commits: [],
          workflowRuns: [],
        },
      ],
      synchronizedEvents: [
        { eventType: 'push', repositoryFullName: 'acme/checkout', sha: 'abc123' },
      ],
    });
  });

  it('seeds commits + workflow runs for the configured repo', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url.includes('/commits'))
          return {
            status: 200,
            json: [
              {
                sha: 'abcdef1234',
                commit: {
                  message: 'fix: thing\n\nbody',
                  author: { name: 'Ada', date: '2026-07-10T00:00:00Z' },
                },
                html_url: 'https://github.com/octo/app/commit/abcdef1234',
              },
            ],
          };
        if (url.includes('/actions/runs'))
          return {
            status: 200,
            json: {
              workflow_runs: [
                {
                  id: 9,
                  name: 'deploy',
                  status: 'completed',
                  conclusion: 'failure',
                  event: 'push',
                  head_branch: 'main',
                  updated_at: 't',
                  html_url: 'u',
                },
              ],
            },
          };
        return { status: 404 };
      }),
    );
    const c = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
    const ctx = await c.fetchTriageContext({ service: 'app', windowMinutes: 60 });
    expect(ctx.source).toBe('github');
    expect(ctx.data).toMatchObject({ service: 'app' });
    const [repository] = ctx.data.repositories as Array<Record<string, unknown>>;
    expect(repository).toMatchObject({ repo: 'octo/app', warnings: [] });
    expect(repository!.commits).toEqual([
      {
        sha: 'abcdef12',
        message: 'fix: thing',
        author: 'Ada',
        at: '2026-07-10T00:00:00Z',
        url: 'https://github.com/octo/app/commit/abcdef1234',
      },
    ]);
    expect(repository!.workflowRuns).toEqual([
      {
        id: 9,
        name: 'deploy',
        status: 'completed',
        conclusion: 'failure',
        event: 'push',
        branch: 'main',
        at: 't',
        url: 'u',
      },
    ]);
  });

  it('returns a note (no network) when no repo is configured', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200 })));
    const c = makeGitHubConnector(cfg({}), fetchImpl, publicLookup);
    const ctx = await c.fetchTriageContext({ service: 'app', windowMinutes: 60 });
    expect(ctx.data).toMatchObject({
      note: 'no repository relationship resolved for this service',
    });
    expect(calls).toHaveLength(0); // never mints or reads
  });

  it('degrades to a note (no throw) when settings.repo is malformed', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200 })));
    const c = makeGitHubConnector(cfg({ repo: 'a/b/c' }), fetchImpl, publicLookup);
    const ctx = await c.fetchTriageContext({ service: 'app', windowMinutes: 60 });
    expect(ctx.data.repositories).toMatchObject([
      { repo: 'a/b/c', error: 'invalid repository mapping' },
    ]);
    expect(calls).toHaveLength(0); // best-effort: never mints or reads on a bad default
  });
});

describe('probe', () => {
  it('enables installation-wide access after repository enumeration, Contents read, and webhook configuration', async () => {
    const { fetchImpl } = makeFetch(
      withMint(
        (url) =>
          url.includes('installation/repositories')
            ? {
                status: 200,
                json: { repositories: [{ id: 1 }, { id: 2 }] },
                rateRemaining: 4990,
                rateReset: 1_787_393_600,
              }
            : { status: 404 },
        { contents: 'read', pull_requests: 'read' },
      ),
    );
    const result = await makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe();
    expect(result).toMatchObject({
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: {
        canEnumerateRepositories: true,
        hasRepositories: true,
        canReadContents: true,
        canReadPullRequests: true,
        canReadActions: false,
        canReadDeployments: false,
        webhookSecretConfigured: true,
      },
      details: { repositoryCount: 2 },
      rateLimitRemaining: 4990,
    });
    expect(result.warnings).toEqual([
      'optional Actions read permission is missing',
      'optional Deployments read permission is missing',
    ]);
  });

  it('rejects an installation that currently exposes no repositories', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) =>
        url.includes('installation/repositories')
          ? { status: 200, json: { repositories: [] } }
          : { status: 404 },
      ),
    );
    const result = await makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      failureCategory: 'permission_denied',
      checks: { canEnumerateRepositories: true, hasRepositories: false },
    });
    expect(result.warnings).toContain('the installation exposes no repositories');
  });

  it('rejects an App without Contents read permission', async () => {
    const { fetchImpl } = makeFetch(
      withMint(
        (url) =>
          url.includes('installation/repositories')
            ? { status: 200, json: { repositories: [{ id: 1 }] } }
            : { status: 404 },
        { deployments: 'read' },
      ),
    );
    const result = await makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      checks: { canReadContents: false, webhookSecretConfigured: true },
    });
    expect(result.warnings).toContain(
      'GitHub App requires Contents repository permission (read) for code diagnosis',
    );
  });

  it('keeps a legacy credential disabled until a webhook secret is configured', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) =>
        url.includes('installation/repositories')
          ? { status: 200, json: { repositories: [{ id: 1 }] } }
          : { status: 404 },
      ),
    );
    const result = await makeGitHubConnector(cfg(), fetchImpl, publicLookup).probe();
    expect(result).toMatchObject({
      status: 'unhealthy',
      checks: { webhookSecretConfigured: false },
    });
    expect(result.warnings).toContain(
      'a dedicated webhook secret is required for event synchronization',
    );
  });

  it('counts repositories across bounded pagination', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url === 'https://api.github.com/installation/repositories?per_page=100')
          return {
            status: 200,
            json: { repositories: [{ id: 1 }] },
            link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"',
          };
        if (url.includes('installation/repositories?per_page=100&page=2'))
          return { status: 200, json: { repositories: [{ id: 2 }] } };
        return { status: 404 };
      }),
    );
    await expect(
      makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe(),
    ).resolves.toMatchObject({ status: 'healthy', details: { repositoryCount: 2 } });
  });

  it('is unauthorized when App authentication fails', async () => {
    const { fetchImpl } = makeFetch(() => ({ status: 401 }));
    await expect(
      makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe(),
    ).resolves.toMatchObject({ status: 'unhealthy', reachable: true, authorized: false });
  });

  it('is unreachable when GitHub authentication does not respond', async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new Error('network');
    });
    await expect(
      makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe(),
    ).resolves.toMatchObject({ status: 'unhealthy', reachable: false, authorized: false });
  });

  it('is unhealthy on a malformed credential', async () => {
    const { fetchImpl } = makeFetch(withMint(() => ({ status: 200 })));
    const result = await makeGitHubConnector(
      cfg({ appId: 'Iv1.appclientid', installationId: 4242 }, 'not json'),
      fetchImpl,
      publicLookup,
    ).probe();
    expect(result).toMatchObject({ status: 'unhealthy', authorized: false });
  });

  it.each([
    [403, 'permission_denied'],
    [429, 'rate_limited'],
    [500, 'provider_unavailable'],
  ] as const)(
    'classifies a %s repository-catalog failure without exposing its body',
    async (status, category) => {
      const { fetchImpl } = makeFetch(
        withMint((url) =>
          url.includes('installation/repositories')
            ? { status, text: 'provider-secret-body' }
            : { status: 404 },
        ),
      );
      const result = await makeGitHubConnector(v2cfg(), fetchImpl, publicLookup).probe();
      expect(result).toMatchObject({
        status: 'unhealthy',
        failureCategory: category,
        checks: { canEnumerateRepositories: false },
      });
      expect(JSON.stringify(result)).not.toContain('provider-secret-body');
    },
  );
});

describe('tool cancellation', () => {
  it('aborts an in-flight GitHub request when the calling investigation is cancelled', async () => {
    const { impl, signals } = abortableFetch((url) => {
      // The installation token mint has its own bound; only the provider read must follow the caller.
      if (/\/app\/installations\/[^/]+$/.test(url))
        return response({ permissions: { contents: 'read' } });
      if (url.includes('/access_tokens'))
        return response({ token: 'ghs_tok', expires_at: FUTURE }, 201);
      return undefined;
    });
    const tool = makeGitHubConnector(cfg(), impl, publicLookup)
      .tools()
      .find((t) => t.name === 'list_commits')!;
    await expectCancelledInFlight((signal) => tool.run({}, { signal }), signals);
  });
});
