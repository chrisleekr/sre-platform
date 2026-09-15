import { expect, it } from 'vitest';
import { cfg, makeFetch, makeGitHubConnector, publicLookup, withMint } from './test-helpers';
import { sourceFileReply, sourceRevision } from './source-file.fixture';

const path = 'apps/api/config.yaml';
const repository = {
  dataSourceId: cfg().id,
  dataSourceName: 'GitHub',
  provider: 'github' as const,
  repositoryId: '42',
  fullName: 'octo/app',
  defaultBranch: 'main',
  webUrl: 'https://github.com/octo/app',
  pathPrefix: 'apps/api',
  mappingSource: 'topology_identity',
  role: 'application_source' as const,
  resolution: 'discovered_mapping' as const,
};

it.each([
  { mode: '120000' },
  { mode: '160000' },
  { mode: '040000' },
  { parentSymlink: true },
  { truncated: true },
])('does not dereference unproven regular files: %j', async (options) => {
  const { fetchImpl, calls } = makeFetch(
    withMint((url) => sourceFileReply(url, path, 'outside component', options)),
  );
  const connector = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
  await expect(connector.sourceCode!.read(repository, sourceRevision, path)).rejects.toThrow();
  expect(
    calls.some((call) => call.url.includes('/contents/') || call.url.includes('/git/blobs/')),
  ).toBe(false);
});

it.each(['100644', '100755'])('reads immutable regular blob mode %s', async (mode) => {
  const { fetchImpl, calls } = makeFetch(
    withMint((url) => sourceFileReply(url, path, 'safe source', { mode })),
  );
  const connector = makeGitHubConnector(cfg(), fetchImpl, publicLookup);
  await expect(connector.sourceCode!.read(repository, sourceRevision, path)).resolves.toMatchObject(
    { text: 'safe source', path, revision: sourceRevision },
  );
  expect(calls.some((call) => call.url.includes('/contents/'))).toBe(false);
  expect(calls.some((call) => call.url.endsWith(`/git/commits/${sourceRevision}`))).toBe(true);
});
