import { describe, expect, test } from 'vitest';
import { cfg, fakeFetch, makeGitLabConnector, publicLookup, type HostLookup } from './test-helpers';

describe('GitLab source-code capability', () => {
  const sha = 'a'.repeat(40);
  const catalog = {
    resolve: async () => [
      {
        repositoryId: '42',
        fullName: 'platform/services/checkout',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://gitlab.example.com/platform/services/checkout',
        path: 'services/checkout',
        source: 'mapping',
        mappingSource: 'argocd',
        confirmed: true,
      },
    ],
    search: async (query: string) =>
      query === 'platform/services/checkout'
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

  test('exposes exact admitted repository resolution through the lazy connector reader', async () => {
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      (async () => {
        throw new Error('No provider request needed');
      }) as unknown as typeof fetch,
      publicLookup,
    );
    const repo = await connector.sourceCode!.resolveRepository!({
      authority: 'repository:gitlab.example.com',
      kind: 'repository',
      id: 'platform/services/checkout',
    });
    expect(repo?.repositoryId).toBe('42');
    expect(
      await connector.sourceCode!.resolveRepository!({
        authority: 'repository:other.example',
        kind: 'repository',
        id: 'platform/services/checkout',
      }),
    ).toBeNull();
  });

  test('reads bounded UTF-8 source from the raw exact-revision endpoint', async () => {
    const source = 'export const checkout = true;\n';
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/repository/commits/'))
        return new Response(JSON.stringify({ id: sha }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/repository/files/') && url.includes('/raw?'))
        return new Response(source, { status: 200, headers: { 'content-type': 'text/plain' } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      fetchImpl,
      publicLookup,
    );
    const [repo] = await connector.sourceCode!.resolve('checkout');
    expect(repo).toMatchObject({
      fullName: 'platform/services/checkout',
      pathPrefix: 'services/checkout',
      mappingSource: 'argocd',
      resolution: 'confirmed_mapping',
    });
    const revision = await connector.sourceCode!.verifyRevision(repo!, 'main');
    const file = await connector.sourceCode!.read(
      repo!,
      revision.revision,
      'services/checkout/src/index.ts',
    );
    expect(file).toMatchObject({
      revision: sha,
      text: source,
      providerUrl: `https://gitlab.example.com/platform/services/checkout/-/blob/${sha}/services/checkout/src/index.ts`,
    });
    expect(calls.some((url) => url.includes(`/raw?ref=${sha}`))).toBe(true);
  });

  test('normalizes code search and comparison evidence at the GitLab adapter boundary', async () => {
    const previous = 'b'.repeat(40);
    const head = 'c'.repeat(40);
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/search?')) {
        return new Response(
          JSON.stringify([
            {
              path: 'services/checkout/src/charge.ts',
              ref: 'main',
              data: 'chargeAccount(customer)',
              startline: 42,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/repository/compare?')) {
        return new Response(
          JSON.stringify({
            compare_timeout: true,
            commits: [{ id: head, title: 'Fix account lookup' }],
            diffs: [{ new_path: 'services/checkout/src/charge.ts', new_file: false }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      fetchImpl,
      publicLookup,
    );
    const [repo] = await connector.sourceCode!.resolve('checkout');

    const search = await connector.sourceCode!.search(repo!, 'chargeAccount', 3);
    const comparison = await connector.sourceCode!.compare(repo!, previous, head);

    expect(search).toEqual({
      incomplete: false,
      matches: [
        {
          path: 'services/checkout/src/charge.ts',
          scope: { kind: 'default_branch', ref: 'main' },
          fragment: 'chargeAccount(customer)',
          line: 42,
        },
      ],
    });
    expect(comparison).toEqual({
      files: [{ path: 'services/checkout/src/charge.ts', status: 'modified' }],
      filesIncomplete: true,
    });
    const searchUrl = new URL(calls.find((url) => url.includes('/search?'))!);
    expect(searchUrl.searchParams.get('scope')).toBe('blobs');
    expect(searchUrl.searchParams.get('search')).toBe('chargeAccount');
    expect(searchUrl.searchParams.get('per_page')).toBe('3');
    const compareUrl = new URL(calls.find((url) => url.includes('/repository/compare?'))!);
    expect(compareUrl.searchParams.get('from')).toBe(previous);
    expect(compareUrl.searchParams.get('to')).toBe(head);
    expect(compareUrl.searchParams.get('straight')).toBe('true');
  });

  test('marks a full GitLab search page as incomplete discovery', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.includes('/search?')) {
        return new Response(
          JSON.stringify(
            Array.from({ length: 3 }, (_, index) => ({
              path: `src/candidate-${index}.ts`,
              ref: 'main',
              data: 'chargeAccount(customer)',
              startline: index + 1,
            })),
          ),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      fetchImpl,
      publicLookup,
    );
    const [repo] = await connector.sourceCode!.resolve('checkout');

    const result = await connector.sourceCode!.search(repo!, 'chargeAccount', 3);

    expect(result.matches).toHaveLength(3);
    expect(result.incomplete).toBe(true);
  });

  test('refuses a repository not present in the synchronized catalog', async () => {
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      fakeFetch().impl,
      publicLookup,
    );
    await expect(
      connector.sourceCode!.read(
        {
          ...(await connector.sourceCode!.resolve('checkout'))[0]!,
          fullName: 'another-group/secret',
        },
        sha,
        'secret.txt',
      ),
    ).rejects.toThrow(/outside the synchronized group catalog/);
  });

  test('retries source-reader initialization after a transient provider lookup failure', async () => {
    let lookups = 0;
    const transientLookup: HostLookup = async () => {
      lookups += 1;
      if (lookups === 1) throw new Error('temporary DNS failure');
      return ['93.184.216.34'];
    };
    const connector = makeGitLabConnector(
      cfg({
        settings: { baseUrl: 'https://gitlab.example.com', groupId: 7 },
        repositories: catalog,
      }),
      fakeFetch().impl,
      transientLookup,
    );

    await expect(connector.sourceCode!.resolve('checkout')).rejects.toThrow(
      'temporary DNS failure',
    );
    await expect(connector.sourceCode!.resolve('checkout')).resolves.toHaveLength(1);
    expect(lookups).toBe(2);
  });
});
