import { describe, expect, test } from 'vitest';
import {
  discoverGitHubInstallations,
  discoverGitHubRepositories,
  makeGitHubConnector,
} from '../index';

const appId = process.env.GITHUB_LIVE_APP_ID;
const installationId = process.env.GITHUB_LIVE_INSTALLATION_ID;
const repo = process.env.GITHUB_LIVE_REPO;
const deploymentId = process.env.GITHUB_LIVE_DEPLOYMENT_ID;
const expectedStatus = process.env.GITHUB_LIVE_EXPECTED_DEPLOYMENT_STATUS;
const privateKey = process.env.GITHUB_LIVE_PRIVATE_KEY?.replaceAll('\\n', '\n');
const configured = Boolean(
  appId && installationId && repo && deploymentId && expectedStatus && privateKey,
);

describe.skipIf(!configured)(
  'GitHub read-only live proof (set App, installation, repository, deployment ID/status, and private-key variables)',
  () => {
    test('discovers granted resources, verifies Deployments read, and snapshots deployment statuses', async () => {
      const installations = await discoverGitHubInstallations({ appId: appId! }, privateKey!);
      expect(installations.some((item) => String(item.id) === installationId)).toBe(true);

      const repositories = await discoverGitHubRepositories(
        { appId: appId!, installationId: installationId! },
        privateKey!,
      );
      expect(repositories.some((item) => item.fullName === repo)).toBe(true);

      const connector = makeGitHubConnector({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Live GitHub',
        tenantId: 'live-proof',
        type: 'github',
        settings: {
          appId: appId!,
          installationId: installationId!,
          repo: repo!,
          pollCursor: { activeProviderIds: [deploymentId!] },
        },
        getCredential: async () => privateKey!,
      });
      await expect(connector.probe()).resolves.toMatchObject({
        status: 'healthy',
        reachable: true,
        authorized: true,
        checks: { canReadRepository: true, canReadDeployments: true },
      });
      const deployments = await connector.snapshot();
      expect(deployments.length).toBeGreaterThan(0);
      expect(deployments.every((item) => item.source === 'github')).toBe(true);
      expect(deployments.every((item) => item.metadata.repo === repo)).toBe(true);
      expect(deployments).toContainEqual(
        expect.objectContaining({
          entityId: deploymentId,
          metadata: expect.objectContaining({ status: expectedStatus }),
        }),
      );
      expect(JSON.stringify({ installations, repositories, deployments })).not.toContain(
        privateKey,
      );
    }, 60_000);
  },
);
