// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { installDialogMethods } from '../../test/dialog';

let dialogMethods: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogMethods = installDialogMethods();
});
afterEach(() => {
  cleanup();
  dialogMethods.restore();
});
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { InfrastructureList } from '../InfrastructureList';
import { DeploymentsList } from '../DeploymentsList';
import { NodeDetail } from '../NodeDetail';
import { ConnectorsPanel } from '../ConnectorsPanel';

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../lib/useConnectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/useConnectors')>();
  return {
    ...actual,
    useConnectors: () => ({
      connectors: [
        {
          id: '00000000-0000-4000-8000-000000000281',
          name: 'Primary Kubernetes',
          type: 'kubernetes',
          enabled: false,
          credentialConfigured: true,
          settings: {},
          verification: {
            lastAttemptAt: '2026-08-28T00:00:00.000Z',
            lastSuccessAt: null,
            failureCategory: 'permission_denied',
            durationMs: 10,
            rateLimit: null,
          },
          capabilities: {
            availability: 'ready',
            configuration: 'tenant',
            instances: 'multiple',
            investigation: 'tools',
            polling: 'snapshots',
            events: 'none',
          },
        },
      ],
      loading: false,
      error: null,
      refetch: vi.fn(),
    }),
  };
});

const declareInvestigation = vi.fn(async () => ({
  outcome: 'created' as const,
  incidentId: '00000000-0000-4000-8000-000000000901',
}));

vi.mock('../../lib/useSurfaces', () => ({
  useSurfaces: () => ({ surfaces: [], loading: false, error: false, refetch: vi.fn() }),
}));

beforeEach(() => {
  declareInvestigation.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ active: [] }), { status: 200 })),
  );
});

const routed = (children: ReactNode) => (
  <MemoryRouter initialEntries={['/']}>{children}</MemoryRouter>
);

describe('shared platform investigation actions', () => {
  test('declares the exact unhealthy infrastructure subject', async () => {
    render(
      routed(
        <InfrastructureList
          snapshots={[
            {
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary Kubernetes',
              source: 'kubernetes',
              entityId: 'argocd/argocd-server',
              metrics: { ready: 1, restartCount: 1, oomKilled: 1 },
              observedAt: new Date().toISOString(),
              kind: 'pod',
              namespace: 'argocd',
              phase: 'Running',
            },
          ]}
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));
    await waitFor(() =>
      expect(declareInvestigation).toHaveBeenCalledWith({
        kind: 'infrastructure_resource',
        dataSourceId: '00000000-0000-4000-8000-000000000001',
        entityId: 'argocd/argocd-server',
      }),
    );
  });

  test('declares the exact failed deployment subject', async () => {
    render(
      routed(
        <DeploymentsList
          deployments={[
            {
              id: '00000000-0000-4000-8000-000000000002',
              dataSourceName: 'GitLab',
              source: 'gitlab',
              repo: 'payments/api',
              ref: 'main',
              transientEnvironment: false,
              sha: 'deadbeef',
              service: 'payments',
              status: 'failed',
              deployedAt: new Date().toISOString(),
            },
          ]}
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));
    await waitFor(() =>
      expect(declareInvestigation).toHaveBeenCalledWith({
        kind: 'deployment',
        deploymentId: '00000000-0000-4000-8000-000000000002',
      }),
    );
  });

  test('declares the exact topology subject from runtime evidence even with an incident overlay', async () => {
    render(
      routed(
        <NodeDetail
          node={{
            name: 'checkout',
            team: 'payments',
            criticality: 'tier1',
            lastDeployAt: null,
            recentDeploys: [],
            status: 'incident',
            runtime: {
              namespace: 'checkout',
              pods: 3,
              healthy: 2,
              attention: 1,
              stale: 0,
              errors: 0,
              restarts: 2,
              oomKilled: 1,
              observedAt: new Date().toISOString(),
            },
          }}
          incidents={[]}
          onClose={() => {}}
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));
    await waitFor(() =>
      expect(declareInvestigation).toHaveBeenCalledWith({
        kind: 'topology_service',
        service: 'checkout',
      }),
    );
  });

  test('declares the exact connector verification subject', async () => {
    const fetchMock = vi.mocked(globalThis.fetch);
    render(routed(<ConnectorsPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Investigate' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input, init]) => {
          if (!String(input).endsWith('/incidents/from-observation')) return false;
          return (
            JSON.stringify(JSON.parse(String(init?.body)).subject) ===
            JSON.stringify({
              kind: 'connector_verification',
              connectorId: '00000000-0000-4000-8000-000000000281',
            })
          );
        }),
      ).toBe(true),
    );
  });

  test('opens exact active workspaces without issuing another declaration', async () => {
    const activeId = '00000000-0000-4000-8000-000000000999';
    const infra = render(
      routed(
        <InfrastructureList
          snapshots={[
            {
              dataSourceId: '00000000-0000-4000-8000-000000000001',
              dataSourceName: 'Primary Kubernetes',
              source: 'kubernetes',
              entityId: 'argocd/argocd-server',
              metrics: { ready: 0 },
              observedAt: new Date().toISOString(),
              kind: 'pod',
              namespace: 'argocd',
              phase: 'Pending',
            },
          ]}
          activeInvestigations={
            new Map([
              [
                'infrastructure_resource:00000000-0000-4000-8000-000000000001:argocd/argocd-server',
                activeId,
              ],
            ])
          }
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open investigation' }));
    expect(declareInvestigation).not.toHaveBeenCalled();
    infra.unmount();

    const deployment = render(
      routed(
        <DeploymentsList
          deployments={[
            {
              id: '00000000-0000-4000-8000-000000000002',
              dataSourceName: 'GitLab',
              source: 'gitlab',
              repo: 'payments/api',
              ref: 'main',
              transientEnvironment: false,
              sha: 'deadbeef',
              service: 'payments',
              status: 'failed',
              deployedAt: new Date().toISOString(),
            },
          ]}
          activeInvestigations={
            new Map([['deployment:00000000-0000-4000-8000-000000000002', activeId]])
          }
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open investigation' }));
    expect(declareInvestigation).not.toHaveBeenCalled();
    deployment.unmount();

    const topology = render(
      routed(
        <NodeDetail
          node={{
            name: 'checkout',
            team: 'payments',
            criticality: 'tier1',
            lastDeployAt: null,
            recentDeploys: [],
            status: 'incident',
            runtime: {
              namespace: 'checkout',
              pods: 1,
              healthy: 0,
              attention: 1,
              stale: 0,
              errors: 0,
              restarts: 1,
              oomKilled: 1,
              observedAt: new Date().toISOString(),
            },
          }}
          incidents={[]}
          onClose={() => {}}
          activeIncidentId={activeId}
          declareInvestigation={declareInvestigation}
        />,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open investigation' }));
    expect(declareInvestigation).not.toHaveBeenCalled();
    topology.unmount();

    const activeFetch = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            active: [
              {
                kind: 'connector_verification',
                sourceId: '00000000-0000-4000-8000-000000000281',
                subjectId: '00000000-0000-4000-8000-000000000281',
                incidentId: activeId,
              },
            ],
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', activeFetch);
    const connector = render(routed(<ConnectorsPanel />));
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open investigation' }));
    expect(declareInvestigation).not.toHaveBeenCalled();
    expect(
      activeFetch.mock.calls.every(([input]) =>
        String(input).endsWith('/incidents/observation-workspaces'),
      ),
    ).toBe(true);
    connector.unmount();
  });
});
