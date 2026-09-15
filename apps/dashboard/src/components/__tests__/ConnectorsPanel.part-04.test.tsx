// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as renderUI,
  screen,
  waitFor,
  within,
} from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ConnectorSummary } from '../../lib/connectors';

import { installDialogMethods } from '../../test/dialog';

type ConnectorFixture = Omit<ConnectorSummary, 'id' | 'name'> &
  Partial<Pick<ConnectorSummary, 'id' | 'name'>>;

const h = vi.hoisted(() => ({
  role: 'admin' as string | undefined,
  impersonation: null as object | null,
  connectors: [] as ConnectorFixture[],
  loading: false,
  error: false,
  refetch: vi.fn(),
  saveKubernetes: vi.fn(),
  testKubernetes: vi.fn(),
  disconnectKubernetes: vi.fn(),
  discoverGitLab: vi.fn(),
  saveGitLab: vi.fn(),
  testGitLab: vi.fn(),
  disconnectGitLab: vi.fn(),
  startGitHubManifest: vi.fn(),
  completeGitHubManifest: vi.fn(),
  discoverGitHubInstallations: vi.fn(),
  discoverGitHubRepositories: vi.fn(),
  saveGitHub: vi.fn(),
  testGitHub: vi.fn(),
  disconnectGitHub: vi.fn(),
  fetchArgoCdAccess: vi.fn(),
  saveArgoCd: vi.fn(),
  testArgoCd: vi.fn(),
  disconnectArgoCd: vi.fn(),
  saveObservability: vi.fn(),
  testObservability: vi.fn(),
  disconnectObservability: vi.fn(),
}));

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../lib/me-store', () => ({
  useMe: () => ({ data: { tenant: { role: h.role, impersonation: h.impersonation } } }),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'tok' }) }),
}));

vi.mock('../../lib/useConnectors', () => ({
  useConnectors: () => ({
    connectors: h.connectors.map((connector, index) => ({
      ...connector,
      id: connector.id ?? `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      name: connector.name ?? connector.type,
    })),
    loading: h.loading,
    error: h.error,
    refetch: h.refetch,
  }),
  saveKubernetesConnector: h.saveKubernetes,
  fetchKubernetesManifest: vi.fn(async () => 'apiVersion: v1'),
  testKubernetesConnector: h.testKubernetes,
  disconnectKubernetesConnector: h.disconnectKubernetes,
  discoverGitLabProjects: h.discoverGitLab,
  saveGitLabConnector: h.saveGitLab,
  testGitLabConnector: h.testGitLab,
  disconnectGitLabConnector: h.disconnectGitLab,
  startGitHubManifest: h.startGitHubManifest,
  completeGitHubManifest: h.completeGitHubManifest,
  discoverGitHubInstallations: h.discoverGitHubInstallations,
  discoverGitHubRepositories: h.discoverGitHubRepositories,
  saveGitHubConnector: h.saveGitHub,
  testGitHubConnector: h.testGitHub,
  disconnectGitHubConnector: h.disconnectGitHub,
  fetchArgoCdAccess: h.fetchArgoCdAccess,
  saveArgoCdConnector: h.saveArgoCd,
  testArgoCdConnector: h.testArgoCd,
  disconnectArgoCdConnector: h.disconnectArgoCd,
  saveObservabilityConnector: h.saveObservability,
  testObservabilityConnector: h.testObservability,
  disconnectObservabilityConnector: h.disconnectObservability,
}));

import { MemoryRouter } from 'react-router-dom';
import type { ReactElement, ReactNode } from 'react';
import { ConnectorsPanel } from '../ConnectorsPanel';

vi.mock('../../lib/useSurfaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/useSurfaces')>()),
  useSurfaces: () => ({ surfaces: [], loading: false, error: false, refetch: vi.fn() }),
}));

function render(ui: ReactElement) {
  const route = `/w/connectors?${h.connectors.length ? 'connection=' + (h.connectors[0]?.id ?? '00000000-0000-4000-8000-000000000001') : 'view=catalog'}`;
  return renderUI(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    ),
  });
}

let dialogMethods: ReturnType<typeof installDialogMethods>;

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
  h.role = 'admin';
  h.impersonation = null;
  dialogMethods = installDialogMethods();
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
  h.connectors = [];
  h.loading = false;
  h.error = false;
  h.refetch.mockReset();
  h.saveKubernetes.mockReset();
  h.testKubernetes.mockReset();
  h.disconnectKubernetes.mockReset();
  h.discoverGitLab.mockReset();
  h.saveGitLab.mockReset();
  h.testGitLab.mockReset();
  h.disconnectGitLab.mockReset();
  h.startGitHubManifest.mockReset();
  h.completeGitHubManifest.mockReset();
  h.discoverGitHubInstallations.mockReset();
  h.discoverGitHubRepositories.mockReset();
  h.saveGitHub.mockReset();
  h.testGitHub.mockReset();
  h.disconnectGitHub.mockReset();
  h.fetchArgoCdAccess.mockReset();
  h.saveArgoCd.mockReset();
  h.testArgoCd.mockReset();
  h.disconnectArgoCd.mockReset();
  h.saveObservability.mockReset();
  h.testObservability.mockReset();
  h.disconnectObservability.mockReset();
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.restoreAllMocks();
});

describe('ConnectorsPanel', () => {
  test('manages ArgoCD without prefilling CA or token and supports retest and disconnect', async () => {
    h.connectors = [
      {
        type: 'argocd',
        settings: {
          baseUrl: 'https://argocd.example.com',
          applicationsInAnyNamespace: false,
          projects: [
            {
              project: 'payments',
              credentialConfigured: true,
              applications: [{ name: 'checkout' }, { name: 'orders' }],
            },
          ],
          caConfigured: true,
        },
        enabled: false,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-22T01:00:00.000Z',
          lastSuccessAt: null,
          failureCategory: 'permission_denied',
          durationMs: 31,
        },
        polling: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          snapshotCount: 0,
          errorCount: 0,
          failureCategory: null,
        },
      },
    ];
    h.fetchArgoCdAccess.mockResolvedValue({
      instructions: {
        project: 'payments',
        role: 'sre-platform',
        identity: 'proj:payments:sre-platform',
        policies: ['policy'],
        tokenCommand: 'token command',
      },
      commands: {
        createRole: 'create',
        addPolicies: 'policies',
        install: 'install',
        uninstall: 'uninstall',
      },
    });
    h.testArgoCd.mockResolvedValue({
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: {
        allProjectIdentitiesMatch: true,
        allProjectReadsVerified: true,
        allProjectDenySamplesPassed: true,
        allProjectsReadable: true,
        allProjectsHaveApplications: true,
      },
      details: {
        projects: [
          {
            project: 'payments',
            status: 'healthy',
            reachable: true,
            authorized: true,
            warnings: [],
            checks: {
              identityMatches: true,
              requiredReadsVerified: true,
              denySamplesPassed: true,
              hasScopedApplications: true,
            },
          },
        ],
      },
      warnings: [],
      enabled: true,
    });
    h.saveArgoCd.mockResolvedValue({
      connectorId: '00000000-0000-4000-8000-000000000001',
    });
    h.disconnectArgoCd.mockResolvedValue(undefined);
    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'argocd' });
    expect(within(card).getByText('CA configured')).toBeDefined();
    expect(within(card).getByText('Failure: permission denied')).toBeDefined();
    const manage = within(card).getByRole('button', { name: 'Manage' });
    fireEvent.click(manage);
    const dialog = screen.getByRole('dialog', { name: 'Manage Argo CD' });
    expect(within(dialog).getByLabelText('CA certificate (PEM)')).toHaveProperty('value', '');
    expect(within(dialog).getByText(/stored PEM is never prefilled/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByLabelText('Argo CD application 1.1')).toHaveProperty(
      'value',
      'checkout',
    );
    expect(within(dialog).getByLabelText('Argo CD application 1.2')).toHaveProperty(
      'value',
      'orders',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByLabelText('Argo CD token for payments')).toHaveProperty('value', '');
    expect(within(dialog).getByText(/Leave blank to keep the saved credential/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify all projects' }));
    expect(
      await within(dialog).findByText('Argo CD connector enabled for every project.'),
    ).toBeDefined();
    expect(h.saveArgoCd).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'argocd',
      settings: {
        baseUrl: 'https://argocd.example.com',
        accessRole: 'sre-platform',
        applicationsInAnyNamespace: false,
        projects: [
          {
            project: 'payments',
            applications: [{ name: 'checkout' }, { name: 'orders' }],
          },
        ],
      },
      credentials: [],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await waitFor(() => expect(document.activeElement).toBe(manage));

    fireEvent.click(within(card).getByRole('button', { name: 'Retest' }));
    await waitFor(() => expect(h.testArgoCd).toHaveBeenCalledTimes(2));
    fireEvent.click(within(card).getByText('More actions'));
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const confirmation = within(card).getByRole('alertdialog', { name: 'Disconnect ArgoCD' });
    expect(
      within(confirmation).getByText(/dashboard configuration and every stored project token/i),
    ).toBeDefined();
    expect(
      within(confirmation).getByText(/cancel now, open Manage.*before disconnecting/i),
    ).toBeDefined();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm disconnect' }));
    await waitFor(() => expect(h.disconnectArgoCd).toHaveBeenCalledTimes(1));
  });

  test('requires project token replacement before saving a changed Argo CD server', () => {
    h.connectors = [
      {
        type: 'argocd',
        settings: {
          baseUrl: 'https://argocd.example.com',
          applicationsInAnyNamespace: false,
          projects: [
            {
              project: 'payments',
              applications: [{ name: 'checkout' }],
              credentialConfigured: true,
            },
          ],
        },
        enabled: true,
        credentialConfigured: true,
      },
    ];
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const dialog = screen.getByRole('dialog', { name: 'Manage Argo CD' });
    fireEvent.change(within(dialog).getByLabelText('Argo CD server URL'), {
      target: { value: 'https://argocd-new.example.com' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      within(dialog).getByText(/server changed.*replacement token is required/i),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Paste a project-role token for project payments.',
    );
  });

  test('requires token replacement after an Argo CD scope edit', () => {
    h.connectors = [
      {
        type: 'argocd',
        settings: {
          baseUrl: 'https://argocd.example.com',
          applicationsInAnyNamespace: false,
          projects: [
            {
              project: 'payments',
              applications: [{ name: 'checkout' }],
              credentialConfigured: true,
            },
          ],
        },
        enabled: true,
        credentialConfigured: true,
      },
    ];
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const dialog = screen.getByRole('dialog', { name: 'Manage Argo CD' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.change(within(dialog).getByLabelText('Argo CD application 1.1'), {
      target: { value: 'orders' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(
      within(dialog).getAllByText(/scope changed.*replacement token is required/i),
    ).toHaveLength(1);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'Paste a project-role token for project payments.',
    );
  });

  test('shows GitLab verification and polling evidence and confirms disconnect', async () => {
    h.connectors = [
      {
        type: 'gitlab',
        settings: {
          baseUrl: 'https://gitlab.example.com',
          projectId: 42,
          service: 'checkout',
        },
        enabled: true,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-21T01:00:00.000Z',
          lastSuccessAt: '2026-08-21T01:00:00.000Z',
          failureCategory: null,
        },
        polling: {
          lastAttemptAt: '2026-08-21T01:01:00.000Z',
          lastSuccessAt: '2026-08-21T01:01:00.000Z',
          snapshotCount: 8,
          errorCount: 0,
          failureCategory: null,
        },
      },
    ];
    h.disconnectGitLab.mockResolvedValue(undefined);
    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'gitlab' });

    expect(within(card).getByText('Verified')).toBeDefined();
    expect(within(card).getByText(/8 snapshots, 0 errors/)).toBeDefined();
    fireEvent.click(within(card).getByText('More actions'));
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const confirmation = within(card).getByRole('alertdialog', { name: 'Disconnect GitLab' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm disconnect' }));

    await waitFor(() => expect(h.disconnectGitLab).toHaveBeenCalledTimes(1));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('renders a sanitized GitLab verification failure category', () => {
    h.connectors = [
      {
        type: 'gitlab',
        settings: { baseUrl: 'https://gitlab.example.com', projectId: 42 },
        enabled: false,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-21T01:00:00.000Z',
          lastSuccessAt: null,
          failureCategory: 'rate_limited',
        },
        polling: {
          lastAttemptAt: '2026-08-21T01:01:00.000Z',
          lastSuccessAt: null,
          snapshotCount: 0,
          errorCount: 1,
          failureCategory: 'rate_limited',
        },
      },
    ];

    render(<ConnectorsPanel />);

    expect(screen.getAllByText('Failure: rate limited')).toHaveLength(2);
    expect(screen.getAllByText(/Last attempt:/)).toHaveLength(2);
    expect(screen.getAllByText('Last success: Never')).toHaveLength(2);
  });
});
