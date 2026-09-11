import { describe, expect, test } from 'vitest';
import {
  cfg,
  deploymentsResp,
  fakeFetch,
  makeGitLabConnector,
  publicLookup,
  type HostLookup,
} from './test-helpers';

describe('makeGitLabConnector fetchTriageContext', () => {
  test('returns recent commits and pipelines as one bundle', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeGitLabConnector(cfg(), impl, publicLookup);

    const ctx = await c.fetchTriageContext({ service: 'group/app', windowMinutes: 60 });

    expect(ctx.source).toBe('gitlab');
    const data = ctx.data as { commits: unknown[]; pipelines: Array<Record<string, unknown>> };
    expect(data.commits).toEqual([
      {
        sha: 'abc1234',
        title: 'fix cart total',
        author: 'Dev A',
        at: '2026-07-01T00:00:00Z',
        url: 'https://gl/c/abc1234',
      },
    ]);
    // sha is shortened to 8 chars; status/ref/source carried through.
    expect(data.pipelines[0]).toMatchObject({
      id: 42,
      status: 'failed',
      ref: 'main',
      sha: 'deadbeef',
      source: 'push',
    });
    // Auth is via the PRIVATE-TOKEN header, and the token never appears in a URL (no leak).
    expect(calls.every((k) => k.token === 'glpat-token')).toBe(true);
    expect(calls.every((k) => !k.url.includes('glpat-token'))).toBe(true);
  });

  test('uses the self-hosted base URL and the service as the URL-encoded project path', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'https://gitlab.example.com/' } }),
      impl,
      publicLookup,
    );

    await c.fetchTriageContext({ service: 'group/app', windowMinutes: 30 });

    expect(calls[0]!.url).toContain(
      'https://gitlab.example.com/api/v4/projects/group%2Fapp/repository/commits',
    );
    expect(calls.some((k) => k.url.includes('/pipelines?'))).toBe(true);
  });

  test('defaults to gitlab.com and honors a configured projectId over the service', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeGitLabConnector(cfg({ settings: { projectId: 71 } }), impl, publicLookup);

    await c.fetchTriageContext({ service: 'ignored', windowMinutes: 30 });

    expect(calls[0]!.url).toContain('https://gitlab.com/api/v4/projects/71/repository/commits');
  });

  test('throws on a non-2xx response (so runTool degrades to error, never a leak)', async () => {
    const { impl } = fakeFetch({ fail: true });
    const c = makeGitLabConnector(cfg(), impl, publicLookup);
    await expect(c.fetchTriageContext({ service: 'g/a', windowMinutes: 10 })).rejects.toThrow(
      /gitlab api 500/,
    );
  });

  test('rejects a non-https base URL (http and file both throw)', async () => {
    const { impl } = fakeFetch();
    const http = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'http://gitlab.example.com' } }),
      impl,
      publicLookup,
    );
    await expect(http.fetchTriageContext({ service: 'g/a', windowMinutes: 10 })).rejects.toThrow(
      /must be https/,
    );
    const file = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'file:///etc/passwd' } }),
      impl,
      publicLookup,
    );
    await expect(file.fetchTriageContext({ service: 'g/a', windowMinutes: 10 })).rejects.toThrow(
      /must be https/,
    );
  });

  test('rejects a link-local / cloud-metadata base URL (SSRF host guard)', async () => {
    const { impl } = fakeFetch();
    // Literal blocked IP: rejected pre-DNS, so the publicLookup is never consulted.
    const c = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'https://169.254.169.254' } }),
      impl,
      publicLookup,
    );
    await expect(c.fetchTriageContext({ service: 'g/a', windowMinutes: 10 })).rejects.toThrow(
      /not allowed/,
    );
  });

  test('permits an HTTPS self-managed GitLab instance on a private network', async () => {
    const { impl, calls } = fakeFetch();
    const privateLookup: HostLookup = async () => ['192.168.1.202'];
    const connector = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'https://gitlab.internal.example' } }),
      impl,
      privateLookup,
    );

    await connector.fetchTriageContext({ service: 'g/a', windowMinutes: 10 });

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith('https://gitlab.internal.example/'))).toBe(
      true,
    );
  });

  test('rejects a public-looking host that resolves to link-local metadata space', async () => {
    const { impl } = fakeFetch();
    const rebindLookup: HostLookup = async () => ['169.254.169.254'];
    const c = makeGitLabConnector(
      cfg({ settings: { baseUrl: 'https://rebind.example.com' } }),
      impl,
      rebindLookup,
    );
    await expect(c.fetchTriageContext({ service: 'x', windowMinutes: 30 })).rejects.toThrow(
      /not allowed/,
    );
  });

  test('bounds each request with a timeout and blocks redirects', async () => {
    const { impl, calls } = fakeFetch();
    await makeGitLabConnector(cfg(), impl, publicLookup).fetchTriageContext({
      service: 'g/a',
      windowMinutes: 10,
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((k) => k.hasSignal)).toBe(true);
    expect(calls.every((k) => k.redirect === 'error')).toBe(true);
  });

  test('propagates a missing-credential rejection', async () => {
    const { impl } = fakeFetch();
    const c = makeGitLabConnector(
      cfg({
        getCredential: async () => {
          throw new Error('no credential stored');
        },
      }),
      impl,
    );
    await expect(c.fetchTriageContext({ service: 'g/a', windowMinutes: 10 })).rejects.toThrow(
      /no credential/,
    );
  });
});

describe('makeGitLabConnector snapshot', () => {
  test('emits one snapshot per GitLab deployment with investigation fields in metadata', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeGitLabConnector(cfg({ settings: { projectId: 71 } }), impl, publicLookup);

    const snaps = await c.snapshot();

    expect(calls.some((k) => k.url.includes('/projects/71/deployments'))).toBe(true);
    expect(snaps).toHaveLength(1);
    const s = snaps[0]!;
    expect(s.source).toBe('gitlab');
    expect(s.tenantId).toBe('t1');
    expect(s.entityId).toBe('42');
    expect(s.metrics).toEqual({});
    // The /deployments endpoint reshapes these metadata fields into the client Deployment.
    expect(s.metadata).toMatchObject({
      providerId: '42',
      projectId: '71',
      repo: '71',
      ref: 'main',
      environment: 'production',
      actor: 'deploy-bot',
      sha: 'deadbeefcafe1234',
      status: 'failed',
      url: 'https://gl/p/42',
      deployedAt: '2026-07-01T00:05:00Z',
    });
    expect(s.observedAt).toBeInstanceOf(Date);
  });

  test('returns [] when no project is configured (nothing to poll)', async () => {
    const { impl, calls } = fakeFetch();
    const c = makeGitLabConnector(cfg(), impl, publicLookup); // settings: {}

    expect(await c.snapshot()).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  // MR1: the persisted deploy needs the service to look up its SLO budget, so the snapshot
  // carries settings.service in metadata. RED today — snapshot metadata has no `service` field.
  test('carries the configured service in each deploy snapshot metadata', async () => {
    const { impl } = fakeFetch();
    const c = makeGitLabConnector(
      cfg({ settings: { projectId: 71, service: 'checkout' } }),
      impl,
      publicLookup,
    );

    const snaps = await c.snapshot();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.metadata).toMatchObject({ service: 'checkout' });
  });

  test('preserves a blocked deployment and uses the deployable pipeline link', async () => {
    const { impl } = fakeFetch({
      deployments: [
        {
          ...deploymentsResp[0],
          status: 'blocked',
          deployable: { pipeline: { web_url: 'https://gl/pipelines/99' } },
        },
      ],
    });
    const [snapshot] = await makeGitLabConnector(
      cfg({ settings: { projectId: 71 } }),
      impl,
      publicLookup,
    ).snapshot();

    expect(snapshot?.metadata).toMatchObject({
      status: 'blocked',
      url: 'https://gl/pipelines/99',
    });
  });

  test('rejects a deployment page larger than the requested item limit', async () => {
    const { impl } = fakeFetch({
      deployments: Array.from({ length: 101 }, (_, id) => ({ ...deploymentsResp[0], id })),
    });
    await expect(
      makeGitLabConnector(cfg({ settings: { projectId: 71 } }), impl, publicLookup).snapshot(),
    ).rejects.toThrow(/page item limit/);
  });

  test('rejects a deployment response over the byte limit before parsing', async () => {
    const fetchImpl = (async () =>
      new Response('[]', {
        status: 200,
        headers: { 'content-length': String(1024 * 1024 + 1) },
      })) as unknown as typeof fetch;
    await expect(
      makeGitLabConnector(cfg({ settings: { projectId: 71 } }), fetchImpl, publicLookup).snapshot(),
    ).rejects.toThrow(/byte limit/);
  });

  test('rejects cursor-bearing incremental pagination beyond the bounded page count', async () => {
    let page = 0;
    const fetchImpl = (async () => {
      page += 1;
      return new Response('[]', {
        status: 200,
        headers: {
          link: `<https://gitlab.com/api/v4/projects/71/deployments?per_page=100&page=${page + 1}>; rel="next"`,
        },
      });
    }) as unknown as typeof fetch;
    await expect(
      makeGitLabConnector(
        cfg({
          settings: {
            projectId: 71,
            pollCursor: { updatedAfter: '2026-07-01T00:05:00.000Z' },
          },
        }),
        fetchImpl,
        publicLookup,
      ).snapshot(),
    ).rejects.toThrow(/page limit/);
    expect(page).toBe(10);
  });

  test('collects short cursorless bootstrap pages without exceeding the 100-item cap', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const pageTwo = new URL(url).searchParams.get('page') === '2';
      return new Response(
        JSON.stringify([
          {
            ...deploymentsResp[0],
            id: pageTwo ? 2 : 1,
            sha: pageTwo ? 'bootstrap-2' : 'bootstrap-1',
          },
        ]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(!pageTwo
              ? {
                  link: '<https://gitlab.com/api/v4/projects/71/deployments?per_page=100&page=2>; rel="next"',
                }
              : {}),
          },
        },
      );
    }) as typeof fetch;

    const snapshots = await makeGitLabConnector(
      cfg({ settings: { projectId: 71 } }),
      fetchImpl,
      publicLookup,
    ).snapshot();

    expect(snapshots.map((snapshot) => snapshot.entityId)).toEqual(['1', '2']);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!).searchParams.get('sort')).toBe('desc');
  });

  test('bootstraps from only the latest 100 deployments even when an older page exists', async () => {
    const calls: string[] = [];
    const page = Array.from({ length: 100 }, (_, id) => ({
      ...deploymentsResp[0],
      id: id + 1,
      sha: `sha-${id + 1}`,
    }));
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          link: '<https://gitlab.com/api/v4/projects/71/deployments?per_page=100&page=2>; rel="next"',
        },
      });
    }) as typeof fetch;

    const snapshots = await makeGitLabConnector(
      cfg({ settings: { projectId: 71 } }),
      fetchImpl,
      publicLookup,
    ).snapshot();

    expect(snapshots).toHaveLength(100);
    expect(calls).toHaveLength(1);
    const bootstrapUrl = new URL(calls[0]!);
    expect(bootstrapUrl.searchParams.get('sort')).toBe('desc');
    expect(bootstrapUrl.searchParams.has('updated_after')).toBe(false);
  });

  test('paginates chronological deployment updates when a durable cursor exists', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      const page = calls.length;
      return new Response(
        JSON.stringify([{ ...deploymentsResp[0], id: page, sha: `incremental-${page}` }]),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            ...(page === 1
              ? {
                  link: '<https://gitlab.com/api/v4/projects/71/deployments?per_page=100&page=2>; rel="next"',
                }
              : {}),
          },
        },
      );
    }) as typeof fetch;

    const snapshots = await makeGitLabConnector(
      cfg({
        settings: {
          projectId: 71,
          pollCursor: { updatedAfter: '2026-07-01T00:05:00.000Z' },
        },
      }),
      fetchImpl,
      publicLookup,
    ).snapshot();

    expect(snapshots.map((snapshot) => snapshot.entityId)).toEqual(['1', '2']);
    expect(calls).toHaveLength(2);
    const incrementalUrl = new URL(calls[0]!);
    expect(incrementalUrl.searchParams.get('sort')).toBe('asc');
    expect(incrementalUrl.searchParams.get('updated_after')).toBe('2026-07-01T00:04:00.000Z');
  });

  test('cancels a chunked JSON response that crosses the byte limit before parsing', async () => {
    let chunks = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (chunks < 2) {
            chunks += 1;
            controller.enqueue(new Uint8Array(600 * 1024).fill(120));
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetchImpl = (async () =>
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    await expect(
      makeGitLabConnector(cfg({ settings: { projectId: 71 } }), fetchImpl, publicLookup).snapshot(),
    ).rejects.toThrow(/byte limit/);
    expect(cancelled).toBe(true);
  });
});

/** A fake fetch for the probe path: routes by URL path suffix to a fixed status code, ignoring the token. */
