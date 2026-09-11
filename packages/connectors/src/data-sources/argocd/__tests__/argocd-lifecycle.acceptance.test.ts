import { describe, expect, test } from 'vitest';
import * as connectorExports from '../../../index';
import type { ConnectorConfig } from '../../../registry';
import type { HostLookup } from '../../../ssrf';
import { makeArgoCdConnector } from '../connector';

interface AccessRequest {
  project: string;
  applicationsInAnyNamespace: boolean;
  applications: Array<{ name: string; namespace?: string }>;
}

interface AccessInstructions {
  project: string;
  role: string;
  identity: string;
  policies: string[];
  tokenCommand: string;
}

type GenerateAccess = (request: AccessRequest) => AccessInstructions;

const lookup: HostLookup = async () => ['93.184.216.34'];
const config: ConnectorConfig = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Acceptance Argo CD',
  tenantId: 'tenant-argocd-acceptance',
  type: 'argocd',
  settings: {
    account: 'sre-platform',
    baseUrl: 'https://argocd.example.com',
    applicationsInAnyNamespace: false,
    applications: [{ project: 'payments', name: 'checkout' }],
  },
  getCredential: async () => 'argocd-token-write-only',
};

function generateAccess(request: AccessRequest): AccessInstructions {
  const candidate = (connectorExports as unknown as Record<string, unknown>).generateArgoCdAccess;
  expect(candidate).toBeTypeOf('function');
  return (candidate as GenerateAccess)(request);
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ArgoCD least-privilege access instructions', () => {
  test('uses a project role with direct two-segment application policies', () => {
    const result = generateAccess({
      project: 'payments',
      applicationsInAnyNamespace: false,
      applications: [{ name: 'checkout' }],
    });

    expect(result).toEqual({
      project: 'payments',
      role: 'sre-platform',
      identity: 'proj:payments:sre-platform',
      policies: [
        'p, proj:payments:sre-platform, applications, get, payments/checkout, allow',
        'p, proj:payments:sre-platform, logs, get, payments/checkout, allow',
      ],
      tokenCommand:
        "argocd proj role create-token 'payments' 'sre-platform' --expires-in 8760h --token-only",
    });
    expect(JSON.stringify(result)).not.toContain('accounts.');
    expect(JSON.stringify(result)).not.toContain('policy.csv');
  });

  test('uses three-segment objects for Applications in any namespace', () => {
    const result = generateAccess({
      project: 'payments',
      applicationsInAnyNamespace: true,
      applications: [{ namespace: 'team-a', name: 'checkout' }],
    });

    expect(result.policies).toEqual([
      'p, proj:payments:sre-platform, applications, get, payments/team-a/checkout, allow',
      'p, proj:payments:sre-platform, logs, get, payments/team-a/checkout, allow',
    ]);
  });
});

describe('ArgoCD verification and snapshot contracts', () => {
  test('verification is unhealthy when the token authenticates but Applications list is forbidden', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith('/api/v1/session/userinfo'))
        return response({ loggedIn: true, username: 'sre-platform' });
      if (url.endsWith('/api/v1/account/sre-platform'))
        return response({ name: 'sre-platform', enabled: true, capabilities: ['apiKey'] });
      if (url.includes('/api/v1/account/can-i/')) {
        const decoded = decodeURIComponent(url);
        const allowed =
          decoded.includes('/applications/get/payments/checkout') ||
          decoded.includes('/logs/get/payments/checkout');
        return response({ value: allowed ? 'yes' : 'no' });
      }
      if (url.includes('/api/v1/applications')) return response({}, 403);
      return response({}, 404);
    }) as typeof fetch;

    await expect(makeArgoCdConnector(config, fetchImpl, lookup).probe()).resolves.toMatchObject({
      status: 'unhealthy',
      reachable: true,
      authorized: true,
      checks: { canListApplications: false },
      failureCategory: 'permission_denied',
    });
  });

  test('keeps live Application state separate from completed multi-source history', async () => {
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (!url.includes('/api/v1/applications')) return response({}, 404);
      return response({
        items: [
          {
            metadata: { name: 'checkout', namespace: 'argocd', uid: 'uid-checkout' },
            spec: {
              project: 'payments',
              destination: {
                server: 'https://kubernetes.default.svc',
                namespace: 'payments-prod',
              },
              sources: [
                { repoURL: 'https://github.com/acme/app', path: 'deploy/app' },
                { repoURL: 'https://github.com/acme/config', path: 'environments/prod' },
              ],
            },
            status: {
              sync: { status: 'OutOfSync', revisions: ['head-app', 'head-config'] },
              health: { status: 'Degraded', message: 'progress deadline exceeded' },
              conditions: [{ type: 'ComparisonError', message: 'render failed' }],
              operationState: {
                phase: 'Running',
                startedAt: '2026-08-22T01:10:00Z',
              },
              history: [
                {
                  id: 7,
                  revisions: ['release-app', 'release-config'],
                  sources: [
                    { repoURL: 'https://github.com/acme/app', path: 'deploy/app' },
                    { repoURL: 'https://github.com/acme/config', path: 'environments/prod' },
                  ],
                  deployStartedAt: '2026-08-22T01:00:00Z',
                  deployedAt: '2026-08-22T01:02:00Z',
                  initiatedBy: { username: 'release-bot' },
                },
              ],
            },
          },
        ],
      });
    }) as typeof fetch;

    const snapshots = await makeArgoCdConnector(config, fetchImpl, lookup).snapshot();
    const live = snapshots.find(
      (snapshot) => snapshot.entityId === 'application:payments/argocd/checkout',
    );

    expect(snapshots).toHaveLength(2);
    expect(live?.metadata).not.toHaveProperty('sha');
    expect(snapshots).toContainEqual(
      expect.objectContaining({
        source: 'argocd',
        entityId: 'application:payments/argocd/checkout',
        metadata: expect.objectContaining({
          kind: 'application',
          applicationId: 'payments/argocd/checkout',
          syncStatus: 'OutOfSync',
          healthStatus: 'Degraded',
          operationPhase: 'Running',
          revisions: ['head-app', 'head-config'],
          destinationServer: 'https://kubernetes.default.svc',
          destinationNamespace: 'payments-prod',
        }),
      }),
    );
    expect(snapshots).toContainEqual(
      expect.objectContaining({
        source: 'argocd',
        entityId: 'deployment:uid-checkout:7',
        metadata: expect.objectContaining({
          kind: 'deployment',
          applicationId: 'payments/argocd/checkout',
          historyId: '7',
          providerId: 'uid-checkout:7',
          revisions: ['release-app', 'release-config'],
          sha: 'release-app',
          operationPhase: 'Succeeded',
          deployStartedAt: '2026-08-22T01:00:00Z',
          deployedAt: '2026-08-22T01:02:00Z',
        }),
      }),
    );
  });
});
