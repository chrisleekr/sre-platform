import { describe, expect, it, test } from 'vitest';
import {
  buildApiUrl,
  cfg,
  discoverGitLabGroup,
  discoverGitLabProjects,
  jsonRes,
  makeGitLabConnector,
  publicLookup,
} from './test-helpers';

function probeFetch(handler: (url: string) => number) {
  return (async (url: string) => {
    const status = handler(String(url));
    return { ok: status < 400, status, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe('makeGitLabConnector probe()', () => {
  test('healthy when /user 200 and configured project readable', async () => {
    const impl = probeFetch((u) => {
      if (u.endsWith('/api/v4/user')) return 200;
      if (u.includes('/api/v4/projects/')) return 200;
      return 404;
    });
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.status).toBe('healthy');
    expect(r.authorized).toBe(true);
    expect(r.checks?.canReadProject).toBe(true);
  });

  test('unhealthy when token unauthorized', async () => {
    const impl = probeFetch(() => 401);
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.status).toBe('unhealthy');
    expect(r.authorized).toBe(false);
    expect(r.failureCategory).toBe('permission_denied');
  });

  test('unhealthy (reachable:false) when the host does not answer', async () => {
    const impl = (async () => {
      throw new Error('network');
    }) as unknown as typeof fetch;
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.reachable).toBe(false);
    expect(r.status).toBe('unhealthy');
    expect(r.failureCategory).toBe('unreachable');
  });

  test('a transient project check cannot enable an unverified connector', async () => {
    // /user answers 200 (authorized) but the project stat call throws (network blip/timeout), so
    // `stat()` returns null. Distinct from the 403/404 "token cannot read" case: this is transient,
    // not a permissions denial, so it must not flip an otherwise-authorized+reachable connector
    // to unhealthy.
    const impl = (async (url: string) => {
      if (String(url).endsWith('/api/v4/user'))
        return { ok: true, status: 200, json: async () => ({}) };
      throw new Error('timeout');
    }) as unknown as typeof fetch;
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.checks?.canReadProject).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('transient');
    expect(r.status).toBe('unhealthy');
    expect(r.failureCategory).toBe('unreachable');
  });

  test('a 5xx project check cannot enable an unverified connector', async () => {
    const impl = probeFetch((u) => {
      if (u.endsWith('/api/v4/user')) return 200;
      if (u.includes('/api/v4/projects/')) return 503;
      return 404;
    });
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.checks?.canReadProject).toBeUndefined();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings.join(' ')).toContain('transient');
    expect(r.status).toBe('unhealthy');
    expect(r.failureCategory).toBe('provider_unavailable');
  });

  test('a 403/404 project-stat result reports canReadProject false and unhealthy', async () => {
    const impl = probeFetch((u) => {
      if (u.endsWith('/api/v4/user')) return 200;
      if (u.includes('/api/v4/projects/')) return 404;
      return 404;
    });
    const c = makeGitLabConnector(cfg({ settings: { projectId: 42 } }), impl, publicLookup);
    const r = await c.probe();
    expect(r.checks?.canReadProject).toBe(false);
    expect(r.warnings.join(' ')).toContain('token cannot read');
    expect(r.status).toBe('unhealthy');
    expect(r.failureCategory).toBe('permission_denied');
  });

  test.each([
    [429, 'rate_limited'],
    [503, 'provider_unavailable'],
  ] as const)('maps identity HTTP %s to %s', async (status, category) => {
    const result = await makeGitLabConnector(
      cfg({ settings: { projectId: 42 } }),
      probeFetch(() => status),
      publicLookup,
    ).probe();
    expect(result.failureCategory).toBe(category);
  });
});

describe('buildApiUrl', () => {
  const base = 'https://gitlab.example.com/api/v4';
  it('builds a path under /api/v4 and defaults per_page', () => {
    expect(buildApiUrl(base, 'projects/1/pipelines')).toBe(
      'https://gitlab.example.com/api/v4/projects/1/pipelines?per_page=20',
    );
  });
  it('clamps per_page to 100', () => {
    const u = new URL(buildApiUrl(base, 'projects/1/pipelines', { per_page: 5000 }));
    expect(u.searchParams.get('per_page')).toBe('100');
  });
  it('rejects an absolute URL that changes origin', () => {
    expect(() => buildApiUrl(base, 'https://evil.example.com/x')).toThrow(/host/);
  });
  it('rejects traversal out of /api/v4', () => {
    expect(() => buildApiUrl(base, '../../admin')).toThrow(/\/api\/v4/);
  });
  it('encodes query values via URLSearchParams', () => {
    const u = new URL(buildApiUrl(base, 'projects/1/issues', { labels: 'a b&c' }));
    expect(u.searchParams.get('labels')).toBe('a b&c');
  });
  it('clamps negative per_page to minimum 1', () => {
    const u = new URL(buildApiUrl(base, 'projects/1/pipelines', { per_page: -5 }));
    expect(u.searchParams.get('per_page')).toBe('1');
  });
  it('falls back to default per_page (20) when given garbage', () => {
    const u = new URL(buildApiUrl(base, 'projects/1/pipelines', { per_page: 'abc' as any }));
    expect(u.searchParams.get('per_page')).toBe('20');
  });
  it('clamps per_page when it arrives inline in the path, not just via the query arg', () => {
    const u = new URL(buildApiUrl(base, 'projects/1/pipelines?per_page=5000'));
    expect(u.searchParams.get('per_page')).toBe('100');
  });
});

describe('discoverGitLabProjects', () => {
  test('returns only allowlisted project identity fields and keeps the token in a header', async () => {
    const calls: Array<{ url: string; token?: string }> = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      calls.push({
        url: String(input),
        token: (init?.headers as Record<string, string> | undefined)?.['PRIVATE-TOKEN'],
      });
      return new Response(
        JSON.stringify([
          {
            id: 42,
            name: 'checkout',
            path_with_namespace: 'platform/checkout',
            web_url: 'https://gitlab.example.com/platform/checkout',
            runners_token: 'must-not-return',
            namespace: { id: 7, owner: { email: 'must-not-return@example.com' } },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    const projects = await discoverGitLabProjects(
      { baseUrl: 'https://gitlab.example.com' },
      'glpat-header-only',
      fetchImpl,
      publicLookup,
    );

    expect(projects).toEqual([
      {
        id: 42,
        name: 'checkout',
        pathWithNamespace: 'platform/checkout',
        webUrl: 'https://gitlab.example.com/platform/checkout',
        archived: false,
      },
    ]);
    expect(calls[0]?.token).toBe('glpat-header-only');
    expect(calls[0]?.url).not.toContain('glpat-header-only');
    expect(JSON.stringify(projects)).not.toContain('must-not-return');
  });

  test('rejects a pagination link outside the validated API origin without requesting it', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response('[]', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://evil.example.com/api/v4/projects?page=2>; rel="next"',
        },
      });
    }) as typeof fetch;

    await expect(
      discoverGitLabProjects(
        { baseUrl: 'https://gitlab.example.com' },
        'glpat-header-only',
        fetchImpl,
        publicLookup,
      ),
    ).rejects.toThrow(/configured origin/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^https:\/\/gitlab\.example\.com\/api\/v4\//);
  });
});

describe('discoverGitLabGroup', () => {
  test('enumerates every directly-owned project in the group and subgroups', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/groups/platform?')) {
        return jsonRes(200, {
          id: 7,
          name: 'Platform',
          full_path: 'platform',
          web_url: 'https://gitlab.example.com/groups/platform',
          runners_token: 'must-not-return',
        });
      }
      if (url.endsWith('/version')) return jsonRes(200, { version: '19.2.4', enterprise: false });
      return jsonRes(200, [
        {
          id: 42,
          name: 'checkout',
          path_with_namespace: 'platform/services/checkout',
          web_url: 'https://gitlab.example.com/platform/services/checkout',
          default_branch: 'main',
          visibility: 'private',
          archived: false,
          last_activity_at: '2026-08-24T00:00:00Z',
        },
      ]);
    }) as typeof fetch;

    const discovery = await discoverGitLabGroup(
      { baseUrl: 'https://gitlab.example.com', groupPath: 'platform' },
      'glpat-header-only',
      fetchImpl,
      publicLookup,
    );

    expect(discovery).toEqual({
      group: {
        id: 7,
        name: 'Platform',
        fullPath: 'platform',
        webUrl: 'https://gitlab.example.com/groups/platform',
      },
      instance: { version: '19.2.4', enterprise: false },
      projects: [
        {
          id: 42,
          name: 'checkout',
          pathWithNamespace: 'platform/services/checkout',
          webUrl: 'https://gitlab.example.com/platform/services/checkout',
          defaultBranch: 'main',
          visibility: 'private',
          archived: false,
          lastActivityAt: '2026-08-24T00:00:00Z',
        },
      ],
    });
    const projectsCall = calls.find((url) => url.includes('/groups/7/projects'))!;
    expect(projectsCall).toContain('include_subgroups=true');
    expect(projectsCall).toContain('with_shared=false');
    expect(JSON.stringify(discovery)).not.toContain('must-not-return');
  });
});

// jsonRes sets content-type explicitly: apiFetch only JSON-parses when the response content-type
// includes application/json (raw job traces are text/plain and must NOT be parsed).
