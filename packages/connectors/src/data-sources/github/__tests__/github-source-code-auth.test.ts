import { describe, expect, it } from 'vitest';
import { sourceFileReply } from './source-file.fixture';
import {
  CRED,
  PEM,
  buildGetUrl,
  cfg,
  githubCredentialBundle,
  githubSmeeUrl,
  makeFetch,
  makeGitHubConnector,
  makeInstallationTokenProvider,
  probeMint,
  publicLookup,
  resolveCreds,
  signAppJwt,
  withMint,
} from './test-helpers';

describe('GitHub source-code capability', () => {
  const sha = 'a'.repeat(40);
  const catalog = {
    resolve: async () => [
      {
        repositoryId: '42',
        fullName: 'octo/app',
        defaultBranch: 'main',
        private: true,
        archived: false,
        htmlUrl: 'https://github.com/octo/app',
        path: 'services/app',
        source: 'mapping',
        mappingSource: 'argocd',
        confirmed: false,
      },
    ],
    search: async () => [],
    recentEvents: async () => [],
  };

  it('discovers source-declared services through the actual GitHub reader at an immutable commit', async () => {
    const entries = await catalog.resolve();
    const { fetchImpl, calls } = makeFetch(
      withMint((url) =>
        sourceFileReply(
          url,
          'services/app/catalog-info.yaml',
          'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: checkout\nspec:\n  type: service\n  lifecycle: production\n  owner: team\n',
        ),
      ),
    );
    const connector = makeGitHubConnector(
      { ...cfg(), repositories: { ...catalog, search: async () => entries } },
      fetchImpl,
      publicLookup,
    );
    const result = await connector.topology!.discover();
    expect(result.collections.find((row) => row.key === 'service-declarations')).toMatchObject({
      completeness: 'complete',
      entities: [expect.objectContaining({ name: 'checkout', kind: 'service' })],
      relations: [
        expect.objectContaining({
          kind: 'declared_in',
          attributes: expect.objectContaining({ revision: sha }),
        }),
      ],
    });
    expect(
      calls
        .filter((call) => call.url.includes('/git/commits/'))
        .every((call) => call.url.endsWith(`/git/commits/${sha}`)),
    ).toBe(true);
  });

  it('retains rate-limit classification through the GitHub client without continuing the source scan', async () => {
    const entries = await catalog.resolve();
    const { fetchImpl, calls } = makeFetch(
      withMint((url) => (url.includes('/commits/') ? { status: 429 } : { status: 404 })),
    );
    const connector = makeGitHubConnector(
      { ...cfg(), repositories: { ...catalog, search: async () => entries } },
      fetchImpl,
      publicLookup,
    );
    const result = await connector.topology!.discover();
    expect(result.collections.find((row) => row.key === 'service-declarations')?.issue).toBe(
      'rate_limited',
    );
    expect(calls.filter((call) => call.url.includes('/commits/'))).toHaveLength(1);
    expect(calls.some((call) => call.url.includes('/contents/'))).toBe(false);
  });

  it.each(['metadata', 'token'])(
    'stops source discovery when installation %s requests are rate limited',
    async (stage) => {
      const entries = await catalog.resolve();
      const fallback = withMint(() => ({ status: 404 }));
      const { fetchImpl, calls } = makeFetch((url, init) => {
        if (
          (stage === 'metadata' && /\/app\/installations\/[^/]+$/.test(url)) ||
          (stage === 'token' && url.includes('/access_tokens'))
        )
          return { status: 429 };
        return fallback(url, init);
      });
      const connector = makeGitHubConnector(
        { ...cfg(), repositories: { ...catalog, search: async () => entries } },
        fetchImpl,
        publicLookup,
      );
      const result = await connector.topology!.discover();
      expect(result.collections.find((row) => row.key === 'service-declarations')?.issue).toBe(
        'rate_limited',
      );
      expect(
        calls.some((call) => call.url.includes('/commits/') || call.url.includes('/contents/')),
      ).toBe(false);
    },
  );

  it('normalizes exact-revision source instead of returning Base64 provider data', async () => {
    const source = 'export function checkout() { return "ok"; }\n';
    const { fetchImpl, calls } = makeFetch(
      withMint((url) => sourceFileReply(url, 'services/app/src/index.ts', source)),
    );
    const connector = makeGitHubConnector(
      { ...cfg(), repositories: catalog },
      fetchImpl,
      publicLookup,
    );
    const resolved = await connector.sourceCode!.resolve('checkout');
    expect(resolved[0]).toMatchObject({
      fullName: 'octo/app',
      pathPrefix: 'services/app',
      mappingSource: 'argocd',
      resolution: 'discovered_mapping',
    });
    const revision = await connector.sourceCode!.verifyRevision(resolved[0]!, 'main');
    const file = await connector.sourceCode!.read(
      resolved[0]!,
      revision.revision,
      'services/app/src/index.ts',
    );
    expect(file).toMatchObject({
      revision: sha,
      text: source,
      providerUrl: `https://github.com/octo/app/blob/${sha}/services/app/src/index.ts`,
    });
    expect(calls.some((call) => call.url.endsWith(`/git/commits/${sha}`))).toBe(true);
  });

  it('requests text-match discovery metadata and preserves incomplete search state', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint((url) =>
        url.includes('/search/code')
          ? {
              status: 200,
              json: {
                incomplete_results: true,
                items: [
                  {
                    path: 'src/index.ts',
                    text_matches: [{ fragment: 'throw new TimeoutError()' }],
                  },
                ],
              },
            }
          : { status: 404 },
      ),
    );
    const connector = makeGitHubConnector(
      { ...cfg(), repositories: catalog },
      fetchImpl,
      publicLookup,
    );
    const [repo] = await connector.sourceCode!.resolve('checkout');
    const result = await connector.sourceCode!.search(repo!, 'TimeoutError', 10);
    expect(result).toEqual({
      incomplete: true,
      matches: [
        {
          path: 'src/index.ts',
          scope: { kind: 'default_branch', ref: 'main' },
          fragment: 'throw new TimeoutError()',
          line: null,
        },
      ],
    });
    expect(calls.find((call) => call.url.includes('/search/code'))?.accept).toBe(
      'application/vnd.github.text-match+json',
    );
  });

  it('marks the provider changed-file ceiling as incomplete', async () => {
    const previous = 'b'.repeat(40);
    const head = 'c'.repeat(40);
    const { fetchImpl } = makeFetch(
      withMint((url) =>
        url.includes('/compare/')
          ? {
              status: 200,
              json: {
                commits: [{ sha: head, commit: { message: 'Large generated update' } }],
                files: Array.from({ length: 300 }, (_, index) => ({
                  filename: `generated/file-${index}.ts`,
                  status: 'modified',
                })),
              },
            }
          : { status: 404 },
      ),
    );
    const connector = makeGitHubConnector(
      { ...cfg(), repositories: catalog },
      fetchImpl,
      publicLookup,
    );
    const [repo] = await connector.sourceCode!.resolve('checkout');

    const comparison = await connector.sourceCode!.compare(repo!, previous, head);

    expect(comparison.files).toHaveLength(300);
    expect(comparison.filesIncomplete).toBe(true);
  });
});

describe('buildGetUrl', () => {
  it('resolves a path under the pinned host and appends query', () => {
    expect(buildGetUrl('https://api.github.com', 'repos/o/r/commits', { per_page: 5 })).toBe(
      'https://api.github.com/repos/o/r/commits?per_page=5',
    );
  });
  it('collapses traversal but keeps the origin', () => {
    expect(buildGetUrl('https://api.github.com', 'repos/o/../x')).toBe(
      'https://api.github.com/repos/x',
    );
  });
  it('rejects an absolute-URL origin escape', () => {
    expect(() => buildGetUrl('https://api.github.com', 'https://evil.com/x')).toThrow(/escapes/);
  });
  it('neutralizes a protocol-relative path onto the pinned host', () => {
    // Leading slashes are stripped, so `//evil.com/x` becomes a harmless path segment, not an escape.
    expect(buildGetUrl('https://api.github.com', '//evil.com/x')).toBe(
      'https://api.github.com/evil.com/x',
    );
  });
});

describe('github auth', () => {
  it('signs an RS256 app JWT with iss = appId', () => {
    const creds = resolveCreds(CRED);
    const jwt = signAppJwt(creds, 1_000_000);
    const [h, p] = jwt.split('.');
    expect(jwt.split('.')).toHaveLength(3);
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toMatchObject({
      alg: 'RS256',
      typ: 'JWT',
    });
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload.iss).toBe('Iv1.appclientid');
    expect(payload.iat).toBe(1_000_000 - 60);
    expect(payload.exp).toBe(1_000_000 + 540); // < 10 min ceiling
  });

  it('rejects a malformed credential', () => {
    expect(() => resolveCreds('not json')).toThrow(/appId/);
    expect(() => resolveCreds(JSON.stringify({ appId: 'x' }))).toThrow(/appId/);
  });

  it('accepts the split private-key secret and legacy JSON during migration', () => {
    expect(resolveCreds(PEM, { appId: 'Iv1.split', installationId: 42 })).toMatchObject({
      appId: 'Iv1.split',
      installationId: 42,
      privateKey: PEM,
    });
    expect(resolveCreds(CRED)).toMatchObject({
      appId: 'Iv1.appclientid',
      installationId: 4242,
      privateKey: PEM,
    });
  });

  it('keeps the Smee channel inside the encrypted credential bundle', () => {
    const credential = githubCredentialBundle(
      PEM,
      'github-webhook-secret-test',
      'https://smee.io/tenant-channel',
    );

    expect(githubSmeeUrl(credential)).toBe('https://smee.io/tenant-channel');
    expect(() =>
      githubCredentialBundle(PEM, 'github-webhook-secret-test', 'https://example.com/not-smee'),
    ).toThrow();
  });

  it('rejects a non-PEM private key', () => {
    const bad = JSON.stringify({ appId: 1, privateKey: 'nope', installationId: 1 });
    expect(() => signAppJwt(resolveCreds(bad), 1)).toThrow(/PEM/);
  });

  it('mints once and memoizes within the refresh window', async () => {
    let clock = 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200, json: {} })));
    const provider = makeInstallationTokenProvider(
      cfg(),
      fetchImpl,
      'https://api.github.com',
      () => clock,
    );
    expect(await provider.token(['octo/app'])).toBe('ghs_tok');
    clock += 100_000; // still far from expiry
    await provider.token(['octo/app']);
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1);
  });

  it('re-mints when the cached token nears expiry', async () => {
    let clock = Date.now();
    const exp = new Date(clock + 3_600_000).toISOString();
    const { fetchImpl, calls } = makeFetch((url) =>
      url.includes('/access_tokens')
        ? { status: 201, json: { token: 'ghs_tok', expires_at: exp } }
        : { status: 200 },
    );
    const provider = makeInstallationTokenProvider(
      cfg(),
      fetchImpl,
      'https://api.github.com',
      () => clock,
    );
    await provider.token();
    clock += 3_600_000 - 30_000; // inside the 60s refresh margin
    await provider.token();
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(2);
  });

  it('falls back to a 1h TTL when expires_at is unparseable', async () => {
    let clock = 1_700_000_000_000;
    const { fetchImpl, calls } = makeFetch((url) =>
      url.includes('/access_tokens')
        ? { status: 201, json: { token: 'ghs_tok' } } // no expires_at
        : { status: 200 },
    );
    const provider = makeInstallationTokenProvider(
      cfg(),
      fetchImpl,
      'https://api.github.com',
      () => clock,
    );
    await provider.token();
    clock += 3_600_000 - 120_000; // ~58 min later, still inside the fallback 1h window
    await provider.token();
    expect(calls.filter((c) => c.url.includes('/access_tokens'))).toHaveLength(1);
  });

  it('mint sends the app JWT as Bearer to the installation token endpoint', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200 })));
    const provider = makeInstallationTokenProvider(cfg(), fetchImpl, 'https://api.github.com');
    await provider.token(['octo/app']);
    const mintCall = calls.find((c) => c.url.includes('/access_tokens'))!;
    expect(mintCall.url).toBe('https://api.github.com/app/installations/4242/access_tokens');
    expect(mintCall.method).toBe('POST');
    expect(mintCall.authorization?.startsWith('Bearer ')).toBe(true);
    expect(mintCall.authorization!.slice(7).split('.')).toHaveLength(3);
    expect(mintCall.redirect).toBe('error');
    expect(JSON.parse(mintCall.body!)).toEqual({
      repositories: ['app'],
      permissions: { contents: 'read', deployments: 'read' },
    });
  });

  it('runtime tokens request one repository and only read permission variants', async () => {
    const { fetchImpl, calls } = makeFetch(
      withMint(() => ({ status: 200 }), {
        deployments: 'write',
        contents: 'write',
        pull_requests: 'read',
        actions: 'write',
      }),
    );
    const provider = makeInstallationTokenProvider(
      cfg({
        repo: 'octo/app',
        permissions: {
          deployments: 'write',
          contents: 'write',
          pull_requests: 'read',
          actions: 'write',
          administration: 'write',
        },
      }),
      fetchImpl,
      'https://api.github.com',
    );
    await provider.token(['octo/app']);
    expect(JSON.parse(calls.find((call) => call.url.includes('/access_tokens'))!.body!)).toEqual({
      repositories: ['app'],
      permissions: {
        deployments: 'read',
        contents: 'read',
        pull_requests: 'read',
        actions: 'read',
      },
    });
  });

  it('re-reads current permissions so optional revocation cannot block deployment polling', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200 })));
    const provider = makeInstallationTokenProvider(
      cfg({
        repo: 'octo/app',
        permissions: { deployments: 'read', contents: 'read', actions: 'read' },
      }),
      fetchImpl,
      'https://api.github.com',
    );

    await provider.token(['octo/app']);
    expect(JSON.parse(calls.find((call) => call.url.includes('/access_tokens'))!.body!)).toEqual({
      repositories: ['app'],
      permissions: { contents: 'read', deployments: 'read' },
    });
  });

  it('mints an installation-wide token only when no repository scope is requested', async () => {
    const { fetchImpl, calls } = makeFetch(withMint(() => ({ status: 200 })));
    const provider = makeInstallationTokenProvider(
      cfg({ repo: undefined }),
      fetchImpl,
      'https://api.github.com',
    );

    await expect(provider.token()).resolves.toBe('ghs_tok');
    expect(JSON.parse(calls.find((call) => call.url.includes('/access_tokens'))!.body!)).toEqual({
      permissions: { contents: 'read', deployments: 'read' },
    });
  });

  it('probeMint reports token / status / malformed distinctly', async () => {
    const ok = makeFetch(withMint(() => ({ status: 200 })));
    expect(
      await probeMint(ok.fetchImpl, 'https://api.github.com', CRED, Date.now(), {
        repo: 'octo/app',
      }),
    ).toMatchObject({
      token: 'ghs_tok',
    });
    const bad = makeFetch(() => ({ status: 401 }));
    expect(
      await probeMint(bad.fetchImpl, 'https://api.github.com', CRED, Date.now(), {
        repo: 'octo/app',
      }),
    ).toEqual({ status: 401 });
    const down = makeFetch(() => {
      throw new Error('network');
    });
    expect(
      await probeMint(down.fetchImpl, 'https://api.github.com', CRED, Date.now(), {
        repo: 'octo/app',
      }),
    ).toEqual({ status: null });
    await expect(
      probeMint(ok.fetchImpl, 'https://api.github.com', 'bad', Date.now()),
    ).rejects.toThrow(/appId/);
  });
});
