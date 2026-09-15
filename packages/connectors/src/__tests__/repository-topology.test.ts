import { expect, test, vi } from 'vitest';
import type { ConnectorConfig } from '../registry';
import { repositoryTopology, repositoryTopologyRef } from '../repository-topology';

test('repository transports normalize without preserving credentials or equating names across hosts', () => {
  expect(repositoryTopologyRef('git@git.example:team/mono.git')).toEqual(
    repositoryTopologyRef('https://git.example/team/mono'),
  );
  expect(repositoryTopologyRef('https://git.example/team/mono')).not.toEqual(
    repositoryTopologyRef('https://other.example/team/mono'),
  );
  expect(repositoryTopologyRef('https://user:password@git.example/team/mono')).toBeNull();
  expect(repositoryTopologyRef('file:///etc/passwd')).toBeNull();
});
test('inventory reads only the connector catalog and does not require a service name', async () => {
  const search = vi.fn(async () => [
    {
      repositoryId: '42',
      fullName: 'team/mono',
      defaultBranch: 'main',
      htmlUrl: 'https://git.example/team/mono',
      private: true,
      archived: false,
    },
  ]);
  const resolve = vi.fn();
  const config: ConnectorConfig = {
    id: 'source',
    tenantId: 'tenant',
    name: 'GitLab',
    type: 'gitlab',
    settings: {},
    getCredential: vi.fn(),
    repositories: { search, resolve, recentEvents: vi.fn() },
  };
  const result = await repositoryTopology(config)!.discover();
  expect(search).toHaveBeenCalledWith('', 100);
  expect(resolve).not.toHaveBeenCalled();
  expect(config.getCredential).not.toHaveBeenCalled();
  expect(result.collections[0]?.entities[0]).toMatchObject({
    kind: 'repository',
    name: 'team/mono',
    attributes: { evidence: 'connector_catalog' },
  });
  const createReader = vi.fn(async () => {
    throw new Error('Source is unavailable');
  });
  const inventoryOnly = await repositoryTopology(config, createReader)!.discover({
    collections: ['repositories'],
  });
  expect(inventoryOnly.collections.map((row) => row.key)).toEqual(['repositories']);
  expect(createReader).not.toHaveBeenCalled();
});
