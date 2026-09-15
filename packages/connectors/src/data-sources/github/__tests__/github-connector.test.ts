import { describe, expect, it } from 'vitest';
import {
  FUTURE,
  cfg,
  makeFetch,
  makeGitHubConnector,
  publicLookup,
  response,
  withMint,
} from './test-helpers';

describe('github connector — shape', () => {
  it('declares installation catalog and repository-scoped investigation tools in a stable order', () => {
    const c = makeGitHubConnector(
      cfg(),
      makeFetch(withMint(() => ({ status: 200 }))).fetchImpl,
      publicLookup,
    );
    expect(c.tools().map((t) => t.name)).toEqual([
      'api_get',
      'resolve_repositories',
      'search_repositories',
      'list_recent_events',
      'list_commits',
      'get_commit',
      'compare_commits',
      'search_code',
      'get_content',
      'list_pull_requests',
      'get_pull_request',
      'list_workflow_runs',
      'get_workflow_run_jobs',
      'get_job_logs',
      'search_issues',
      'get_issue',
    ]);
  });

  it('maps deployment and latest-status provider identity for persistence', async () => {
    const c = makeGitHubConnector(
      cfg(),
      makeFetch(
        withMint((url) => {
          if (url.endsWith('/deployments?per_page=100'))
            return {
              status: 200,
              json: [
                {
                  id: 91,
                  ref: 'main',
                  sha: 'abcdef',
                  environment: 'production',
                  transient_environment: true,
                  created_at: '2026-08-22T00:00:00Z',
                  creator: { login: 'octocat' },
                },
              ],
            };
          if (url.endsWith('/deployments/91/statuses?per_page=1'))
            return {
              status: 200,
              json: [
                {
                  state: 'inactive',
                  updated_at: '2026-08-22T00:01:00Z',
                  environment_url: 'https://app.example.com',
                  creator: { login: 'deploy-bot' },
                },
              ],
            };
          return { status: 404 };
        }),
      ).fetchImpl,
      publicLookup,
    );
    await expect(c.snapshot()).resolves.toMatchObject([
      {
        source: 'github',
        entityId: '91',
        metadata: {
          providerId: '91',
          repo: 'octo/app',
          ref: 'main',
          sha: 'abcdef',
          environment: 'production',
          transientEnvironment: true,
          actor: 'deploy-bot',
          status: 'inactive',
          url: 'https://app.example.com',
          deployedAt: '2026-08-22T00:01:00Z',
        },
      },
    ]);
    expect(c.pollEvidence?.()).toMatchObject({
      cursor: { recentHeadProviderId: '91', activeProviderIds: [] },
    });
  });

  it('refreshes active deployment IDs and advances the bounded cursor after serial status reads', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint((url) => {
        if (url.endsWith('/deployments?per_page=100'))
          return { status: 200, json: [{ id: 20, sha: 'new', ref: 'main' }] };
        if (url.endsWith('/deployments/10'))
          return { status: 200, json: { id: 10, sha: 'old', ref: 'main' } };
        if (url.endsWith('/deployments/20/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'success' }] };
        if (url.endsWith('/deployments/10/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'pending' }] };
        return { status: 404 };
      }),
    );
    const connector = makeGitHubConnector(
      cfg({
        repo: 'octo/app',
        pollCursor: { recentHeadProviderId: '19', activeProviderIds: ['10'] },
      }),
      fetchImpl,
      publicLookup,
    );
    await expect(connector.snapshot()).resolves.toHaveLength(2);
    expect(connector.pollEvidence?.()).toMatchObject({
      cursor: { recentHeadProviderId: '20', activeProviderIds: ['10'] },
    });
    expect(
      calls.filter((call) => call.url.includes('/statuses?per_page=1')).map((call) => call.url),
    ).toEqual([
      'https://api.github.com/repos/octo/app/deployments/20/statuses?per_page=1',
      'https://api.github.com/repos/octo/app/deployments/10/statuses?per_page=1',
    ]);
  });

  it('fails closed with backlog evidence when a cursor falls beyond the bounded latest page', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint((url) =>
        url.endsWith('/deployments?per_page=100')
          ? {
              status: 200,
              json: Array.from({ length: 100 }, (_, index) => ({ id: 1000 - index })),
              link: '<https://api.github.com/repos/octo/app/deployments?per_page=100&page=2>; rel="next"',
            }
          : { status: 404 },
      ),
    );
    const connector = makeGitHubConnector(
      cfg({
        repo: 'octo/app',
        pollCursor: { recentHeadProviderId: '1', activeProviderIds: [] },
      }),
      fetchImpl,
      publicLookup,
    );
    await expect(connector.snapshot()).rejects.toThrow(/backlog/);
    expect(connector.pollEvidence?.()).toMatchObject({ failureCategory: 'backlog' });
    expect(calls.some((call) => call.url.includes('/statuses'))).toBe(false);
  });

  it('replaces prior success evidence after a later provider failure and rate limit', async () => {
    let mode: 'success' | 'provider' | 'rate' = 'success';
    const reset = 1_787_393_600;
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url.endsWith('/deployments?per_page=100')) {
          if (mode === 'provider') return { status: 503 };
          if (mode === 'rate') return { status: 429, rateRemaining: 0, rateReset: reset };
          return { status: 200, json: [{ id: 20, sha: 'new' }] };
        }
        if (url.endsWith('/deployments/20/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'success' }] };
        return { status: 404 };
      }),
    );
    const cursor = { recentHeadProviderId: '19', activeProviderIds: [] };
    const connector = makeGitHubConnector(
      cfg({ repo: 'octo/app', pollCursor: cursor }),
      fetchImpl,
      publicLookup,
    );
    await expect(connector.snapshot()).resolves.toHaveLength(1);
    expect(connector.pollEvidence?.()?.failureCategory).toBeUndefined();

    mode = 'provider';
    await expect(connector.snapshot()).rejects.toThrow(/503/);
    expect(connector.pollEvidence?.()).toMatchObject({
      cursor,
      failureCategory: 'provider_unavailable',
    });

    mode = 'rate';
    await expect(connector.snapshot()).rejects.toThrow(/429/);
    expect(connector.pollEvidence?.()).toMatchObject({
      cursor,
      failureCategory: 'rate_limited',
      rateLimitRemaining: 0,
      rateLimitResetAt: new Date(reset * 1000).toISOString(),
    });
  });

  it('treats a capped deployment page with a next link as backlog without advancing', async () => {
    const cursor = { recentHeadProviderId: '19', activeProviderIds: [] };
    const { fetchImpl, calls } = makeFetch(
      withMint((url) =>
        url.endsWith('/deployments?per_page=100')
          ? {
              status: 200,
              json: Array.from({ length: 100 }, (_, index) => ({ id: index + 100 })),
              link: '<https://api.github.com/repos/octo/app/deployments?per_page=100&page=2>; rel="next"',
            }
          : { status: 500 },
      ),
    );
    const connector = makeGitHubConnector(
      cfg({ repo: 'octo/app', pollCursor: cursor }),
      fetchImpl,
      publicLookup,
    );
    await expect(connector.snapshot()).rejects.toThrow(/backlog/);
    expect(connector.pollEvidence?.()).toMatchObject({ cursor, failureCategory: 'backlog' });
    expect(calls.some((call) => call.url.includes('page=2'))).toBe(false);
  });

  it('bootstraps a mature repository from a visible latest-100 baseline', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint((url) => {
        if (url.endsWith('/deployments?per_page=100'))
          return {
            status: 200,
            json: Array.from({ length: 100 }, (_, index) => ({
              id: index + 100,
              sha: `sha-${index}`,
            })),
            link: '<https://api.github.com/repos/octo/app/deployments?per_page=100&page=2>; rel="next"',
          };
        if (url.includes('/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'success' }] };
        return { status: 404 };
      }),
    );
    const connector = makeGitHubConnector(cfg(), fetchImpl, publicLookup);

    await expect(connector.snapshot()).resolves.toHaveLength(100);
    expect(connector.pollEvidence?.()).toMatchObject({
      cursor: {
        recentHeadProviderId: '100',
        activeProviderIds: [],
        baselineTruncated: true,
      },
    });
    expect(calls.some((call) => call.url.includes('page=2'))).toBe(false);
  });

  it('advances after a deleted prior head when the complete current collection fits the bound', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url.endsWith('/deployments?per_page=100'))
          return {
            status: 200,
            json: Array.from({ length: 100 }, (_, index) => ({
              id: index + 200,
              sha: `sha-${index}`,
            })),
          };
        if (url.includes('/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'success' }] };
        return { status: 404 };
      }),
    );
    const connector = makeGitHubConnector(
      cfg({
        repo: 'octo/app',
        pollCursor: { recentHeadProviderId: 'deleted', activeProviderIds: [] },
      }),
      fetchImpl,
      publicLookup,
    );

    await expect(connector.snapshot()).resolves.toHaveLength(100);
    expect(connector.pollEvidence?.()).toMatchObject({
      cursor: { recentHeadProviderId: '200', activeProviderIds: [] },
    });
  });

  it('fails as backlog instead of dropping the 51st active deployment', async () => {
    const { fetchImpl } = makeFetch(
      withMint((url) => {
        if (url.endsWith('/deployments?per_page=100'))
          return {
            status: 200,
            json: Array.from({ length: 51 }, (_, index) => ({
              id: index + 1,
              sha: `sha-${index}`,
            })),
          };
        if (url.includes('/statuses?per_page=1'))
          return { status: 200, json: [{ state: 'pending' }] };
        return { status: 404 };
      }),
    );
    const connector = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
    await expect(connector.snapshot()).rejects.toThrow(/active deployment backlog/);
    expect(connector.pollEvidence?.()).toMatchObject({ failureCategory: 'backlog' });
  });

  it('never overlaps latest-status requests', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (/\/app\/installations\/[^/]+$/.test(url))
        return response({ permissions: { deployments: 'read' } });
      if (url.includes('/access_tokens'))
        return response({ token: 'ghs_tok', expires_at: FUTURE }, 201);
      if (url.endsWith('/deployments?per_page=100'))
        return response([
          { id: 1, sha: 'one' },
          { id: 2, sha: 'two' },
          { id: 3, sha: 'three' },
        ]);
      if (url.includes('/statuses?per_page=1')) {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
        return response([{ state: 'success' }]);
      }
      return response({}, 404);
    }) as typeof fetch;
    await makeGitHubConnector(cfg(), fetchImpl, publicLookup).snapshot();
    expect(maxInFlight).toBe(1);
  });

  it.each([
    [{}, 'permission_denied'],
    [{ 'x-ratelimit-remaining': '0' }, 'rate_limited'],
  ] as const)('classifies a bounded 403 from its actual headers', async (headers, category) => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (/\/app\/installations\/[^/]+$/.test(url))
        return response({ permissions: { deployments: 'read' } });
      if (url.includes('/access_tokens'))
        return response({ token: 'ghs_tok', expires_at: FUTURE }, 201);
      return response({}, 403, headers);
    }) as typeof fetch;
    const connector = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
    await expect(connector.snapshot()).rejects.toThrow(/403/);
    expect(connector.pollEvidence?.()?.failureCategory).toBe(category);
  });
});
