import { expect, test, vi } from 'vitest';
import { resolveSourceRepository } from '../source-repository';
import { repositoryTopologyRef } from '../repository-topology';
import type { ConnectorConfig } from '../registry';

test('resolves only a unique admitted external repository identity without external requests', async () => {
  const entry = {
    repositoryId: '42',
    fullName: 'team/mono',
    defaultBranch: 'main',
    htmlUrl: 'https://git.example/team/mono',
    private: true,
    archived: false,
  };
  const search = vi.fn(async () => [entry]);
  const config: ConnectorConfig = {
    id: 'source',
    name: 'GitLab',
    type: 'gitlab',
    tenantId: 'tenant',
    settings: {},
    getCredential: vi.fn(),
    repositories: { search, resolve: vi.fn(), recentEvents: vi.fn() },
  };
  const found = await resolveSourceRepository(
    config,
    'gitlab',
    repositoryTopologyRef('git@git.example:team/mono.git')!,
  );
  expect(found).toMatchObject({ repositoryId: '42', dataSourceId: 'source' });
  expect(config.getCredential).not.toHaveBeenCalled();
  expect(config.repositories?.resolve).not.toHaveBeenCalled();
  expect(
    await resolveSourceRepository(
      config,
      'gitlab',
      repositoryTopologyRef('https://foreign.example/team/mono')!,
    ),
  ).toBeNull();
  search.mockResolvedValue([entry, { ...entry, repositoryId: 'other' }]);
  expect(
    await resolveSourceRepository(config, 'gitlab', repositoryTopologyRef(entry.htmlUrl)!),
  ).toBeNull();
});
