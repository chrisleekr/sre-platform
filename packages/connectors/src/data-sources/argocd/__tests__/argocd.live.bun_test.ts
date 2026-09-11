import { describe, expect, test } from 'bun:test';
import { makeArgoCdConnector } from '../connector';

const baseUrl = process.env.ARGOCD_LIVE_BASE_URL;
const token = process.env.ARGOCD_LIVE_TOKEN;
const deniedToken = process.env.ARGOCD_LIVE_DENIED_TOKEN;
const application = process.env.ARGOCD_LIVE_APPLICATION;
const project = process.env.ARGOCD_LIVE_PROJECT ?? 'default';
const caCert = process.env.ARGOCD_LIVE_CA;
const configured = Boolean(baseUrl && token && deniedToken && application && caCert);
const liveTest = configured ? test : test.skip;

describe('ArgoCD disposable read-only proof', () => {
  const settings = {
    baseUrl: baseUrl!,
    caCert: caCert!,
    applicationsInAnyNamespace: false,
    projects: [{ project, applications: [{ name: application! }] }],
  };

  liveTest(
    'proves CA-pinned identity, scoped discovery, live state, completed history, and RBAC denial',
    async () => {
      expect(process.versions.bun).toBeDefined();
      const connector = makeArgoCdConnector({
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Live Argo CD',
        tenantId: 'argocd-live',
        type: 'argocd',
        settings,
        getCredential: async () =>
          JSON.stringify({ version: 1, tokens: [{ project, token: token! }] }),
      });
      const probe = await connector.probe();
      expect(probe, JSON.stringify(probe)).toMatchObject({
        status: 'healthy',
        authorized: true,
        checks: { allProjectsReadable: true, allProjectsHaveApplications: true },
      });
      const snapshots = await connector.snapshot();
      expect(snapshots).toContainEqual(
        expect.objectContaining({
          entityId: `application:${project}/argocd/${application}`,
          metadata: expect.objectContaining({ kind: 'application' }),
        }),
      );
      expect(
        snapshots.some(
          (snapshot) =>
            snapshot.metadata.kind === 'deployment' &&
            snapshot.metadata.applicationId === `${project}/argocd/${application}`,
        ),
      ).toBe(true);

      const denied = makeArgoCdConnector({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Denied Argo CD',
        tenantId: 'argocd-live-denied',
        type: 'argocd',
        settings,
        getCredential: async () =>
          JSON.stringify({ version: 1, tokens: [{ project, token: deniedToken! }] }),
      });
      await expect(denied.probe()).resolves.toMatchObject({
        status: 'unhealthy',
        checks: { allProjectReadsVerified: false },
        failureCategory: 'permission_denied',
      });
      expect(JSON.stringify({ snapshots, evidence: connector.pollEvidence?.() })).not.toContain(
        token,
      );
    },
    60_000,
  );
});
