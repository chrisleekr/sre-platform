import { describe, expect, test } from 'vitest';
import { discoverGitLabGroup, makeGitLabConnector } from '../index';

const baseUrl = process.env.GITLAB_LIVE_BASE_URL;
const token = process.env.GITLAB_LIVE_TOKEN;
const groupPath = process.env.GITLAB_LIVE_GROUP_PATH;
const configured = Boolean(baseUrl && token && groupPath);

describe.skipIf(!configured)(
  'GitLab group read-only live proof (set GITLAB_LIVE_BASE_URL, GITLAB_LIVE_TOKEN, GITLAB_LIVE_GROUP_PATH)',
  () => {
    test('enumerates the group and verifies representative incident reads', async () => {
      const discovery = await discoverGitLabGroup(
        { baseUrl: baseUrl!, groupPath: groupPath! },
        token!,
      );
      expect(discovery.projects.length).toBeGreaterThan(0);
      const catalog = discovery.projects.map((project) => ({
        repositoryId: String(project.id),
        fullName: project.pathWithNamespace,
        defaultBranch: project.defaultBranch ?? null,
        private: project.visibility === 'private',
        archived: project.archived,
        htmlUrl: project.webUrl,
      }));
      const connector = makeGitLabConnector({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Live GitLab',
        tenantId: 'live-proof',
        type: 'gitlab',
        settings: {
          baseUrl: baseUrl!,
          groupId: discovery.group.id,
          groupPath: discovery.group.fullPath,
          eventTransport: 'none',
        },
        getCredential: async () => token!,
        repositories: {
          resolve: async () => catalog.slice(0, 1),
          search: async (query) =>
            catalog.filter(
              (project) =>
                project.repositoryId === query ||
                project.fullName.toLowerCase().includes(query.toLowerCase()),
            ),
          recentEvents: async () => [],
        },
      });

      const probe = await connector.probe();
      expect(probe).toMatchObject({
        status: 'healthy',
        reachable: true,
        authorized: true,
        checks: {
          canReadGroup: true,
          canEnumerateProjects: true,
          hasProjects: true,
          canReadCode: true,
          canReadPipelines: true,
          canReadDeployments: true,
        },
      });
      await expect(connector.snapshot()).resolves.toEqual([]);
    }, 30_000);
  },
);
