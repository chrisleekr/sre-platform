import { expect, test, vi } from 'vitest';
import type { ConnectorConfig } from '../registry';
import type { SourceCodeReader, SourceRepository } from '../types';
import { repositoryServiceDiscovery } from '../repository-service-discovery';
import { SourceFileNotFoundError, SourceRateLimitError } from '../source-file-error';

const text =
  'apiVersion: backstage.io/v1alpha1\nkind: Component\nmetadata:\n  name: checkout\nspec:\n  type: service\n  owner: team\n  lifecycle: production\n';
const revision = 'a'.repeat(40);
function fixture(count = 1) {
  const repositories = Array.from({ length: count }, (_, i) => ({
    repositoryId: String(i + 1),
    fullName: `team/app-${i + 1}`,
    defaultBranch: 'main',
    htmlUrl: `https://git.example/team/app-${i + 1}`,
    private: true,
    archived: false,
  }));
  const config: ConnectorConfig = {
    id: 'source',
    tenantId: 'tenant',
    name: 'GitLab',
    type: 'gitlab',
    settings: {},
    getCredential: vi.fn(),
    repositories: {
      resolve: vi.fn(),
      recentEvents: vi.fn(),
      search: vi.fn(async () => repositories),
      page: vi.fn(async (after, limit) =>
        repositories.slice(after ? Number(after) : 0, (after ? Number(after) : 0) + limit),
      ),
    },
  };
  const reader: SourceCodeReader = {
    resolve: vi.fn(),
    search: vi.fn(),
    compare: vi.fn(),
    resolveRepository: vi.fn(async (reference) => {
      const entry = repositories.find((entry) => entry.fullName === reference.id)!;
      return {
        dataSourceId: config.id,
        dataSourceName: config.name,
        provider: 'gitlab',
        repositoryId: entry.repositoryId,
        fullName: entry.fullName,
        defaultBranch: entry.defaultBranch,
        webUrl: entry.htmlUrl,
        pathPrefix: 'apps/checkout',
        role: 'application_source',
        mappingSource: 'catalog',
        resolution: 'discovered_mapping',
      } as SourceRepository;
    }),
    verifyRevision: vi.fn(async () => ({ revision, providerUrl: 'https://git.example/commit' })),
    read: vi.fn(async (_repo, pinned, path) => ({
      path,
      revision: pinned,
      text,
      providerUrl: 'https://git.example/file',
    })),
  };
  return { config, reader };
}

test('reads admitted component metadata at an immutable commit and rechecks admission', async () => {
  const { config, reader } = fixture();
  const result = await repositoryServiceDiscovery(config, () => reader);
  expect(result).toMatchObject({
    completeness: 'complete',
    scan: { cursor: null, incomplete: false },
  });
  expect(result.entities).toHaveLength(1);
  expect(reader.read).toHaveBeenCalledWith(
    expect.objectContaining({ repositoryId: '1' }),
    revision,
    'apps/checkout/catalog-info.yaml',
  );
  expect(reader.resolveRepository).toHaveBeenCalledTimes(2);
  expect(reader.search).not.toHaveBeenCalled();
  expect(config.getCredential).not.toHaveBeenCalled();
});

test('continues across all admitted repositories rather than repeating the initial subset', async () => {
  const { config, reader } = fixture(7);
  const first = await repositoryServiceDiscovery(config, () => reader);
  expect(first.entities).toHaveLength(5);
  expect(first.scan?.cursor).toBe('5');
  const second = await repositoryServiceDiscovery(config, () => reader, first.scan);
  expect(second.entities).toHaveLength(2);
  expect(second.scan?.cursor).toBeNull();
  expect(reader.read).toHaveBeenCalledTimes(7);
});

test('missing metadata is empty only after confirming the same commit is still accessible', async () => {
  const { config, reader } = fixture();
  vi.mocked(reader.read).mockRejectedValue(new SourceFileNotFoundError());
  const empty = await repositoryServiceDiscovery(config, () => reader);
  expect(empty).toMatchObject({ completeness: 'complete', entities: [], relations: [] });
  expect(reader.verifyRevision).toHaveBeenLastCalledWith(expect.anything(), revision);
  vi.mocked(reader.verifyRevision)
    .mockResolvedValueOnce({ revision, providerUrl: '' })
    .mockRejectedValue(new Error('denied'));
  expect((await repositoryServiceDiscovery(config, () => reader)).completeness).toBe('partial');
});

test.each(['path', 'revision', 'admission'])('discards source on %s mismatch', async (mode) => {
  const { config, reader } = fixture();
  if (mode === 'admission')
    vi.mocked(reader.resolveRepository!)
      .mockResolvedValueOnce(
        await reader.resolveRepository!({ authority: '', kind: '', id: 'team/app-1' }),
      )
      .mockResolvedValueOnce(null);
  else
    vi.mocked(reader.read).mockImplementationOnce(async (_repo, pinned, path) => ({
      text,
      providerUrl: '',
      path: mode === 'path' ? 'other.yaml' : path,
      revision: mode === 'revision' ? 'b'.repeat(40) : pinned,
    }));
  const result = await repositoryServiceDiscovery(config, () => reader);
  expect(result.completeness).toBe('partial');
  expect(result.entities).toEqual([]);
});

test('stops on rate limiting without skipping the interrupted repository', async () => {
  const { config, reader } = fixture(4);
  vi.mocked(reader.read).mockRejectedValue(new SourceRateLimitError());
  const result = await repositoryServiceDiscovery(config, () => reader);
  expect(result).toMatchObject({
    completeness: 'partial',
    issue: 'rate_limited',
    scan: { cursor: null, incomplete: true },
  });
  expect(reader.read).toHaveBeenCalledTimes(1);
});
