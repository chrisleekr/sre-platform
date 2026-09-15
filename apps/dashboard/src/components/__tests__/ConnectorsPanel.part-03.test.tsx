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
  test('shows distinct ArgoCD verification failures and keeps the draft disabled', async () => {
    h.fetchArgoCdAccess.mockResolvedValue({
      instructions: {
        project: 'default',
        role: 'sre-platform',
        identity: 'proj:default:sre-platform',
        policies: [],
        tokenCommand: 'argocd proj role create-token default sre-platform',
      },
      commands: {
        createRole: 'argocd proj role create default',
        addPolicies: 'argocd proj role add-policy default',
        install: 'argocd proj role create default',
        uninstall: 'argocd proj role delete default',
      },
    });
    h.saveArgoCd.mockResolvedValue({
      connectorId: '00000000-0000-4000-8000-000000000044',
    });
    h.testArgoCd.mockResolvedValue({
      status: 'unhealthy',
      reachable: true,
      authorized: true,
      checks: {
        allProjectIdentitiesMatch: true,
        allProjectReadsVerified: false,
        allProjectDenySamplesPassed: false,
        allProjectsReadable: false,
        allProjectsHaveApplications: false,
      },
      details: {
        projects: [
          {
            project: 'default',
            status: 'unhealthy',
            reachable: true,
            authorized: true,
            warnings: ['token permissions do not match the configured read-only scope'],
            checks: {
              identityMatches: true,
              requiredReadsVerified: false,
              denySamplesPassed: false,
              hasScopedApplications: false,
            },
          },
        ],
      },
      warnings: ['default: token permissions do not match the configured read-only scope'],
      enabled: false,
    });
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Argo CD' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Argo CD' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Generate dedicated access' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate access commands' }));
    await within(dialog).findByText(/argocd proj role create default/);
    fireEvent.change(within(dialog).getByLabelText('Argo CD token for default'), {
      target: { value: 'argocd-token-browser-only' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify all projects' }));

    expect(await within(dialog).findByText(/connector remains disabled/i)).toBeDefined();
    expect(within(dialog).getByText('Project-role identity: verified')).toBeDefined();
    expect(
      within(dialog).getByText('Required application and log reads: incomplete'),
    ).toBeDefined();
    expect(
      within(dialog).getByText('Known over-grant samples: detected or not completed'),
    ).toBeDefined();
    expect(within(dialog).getByText('Scoped applications: none found or unreadable')).toBeDefined();
    expect(within(dialog).getByText(/token permissions do not match/)).toBeDefined();
  });

  test('manages GitHub without projecting secrets and shows repository and event health', async () => {
    h.connectors = [
      {
        type: 'github',
        settings: {
          appId: 'Iv1.saved',
          installationId: '101',
          accountLogin: 'acme',
          appSlug: 'sre-triage',
          eventTransport: 'smee',
          smeeConfigured: true,
        },
        repositoryCount: 312,
        webhookPath: '/webhooks/github/opaque-key',
        enabled: true,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-22T01:00:00.000Z',
          lastSuccessAt: '2026-08-22T01:00:00.000Z',
          failureCategory: null,
          durationMs: 42,
          rateLimit: { remaining: 4900, resetAt: '2026-08-22T02:00:00.000Z' },
        },
        events: {
          lastAttemptAt: '2026-08-22T01:01:00.000Z',
          lastSuccessAt: '2026-08-22T01:01:00.000Z',
          count: 128,
          failureCategory: null,
        },
      },
    ];
    h.disconnectGitHub.mockResolvedValue(undefined);
    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'github' });
    expect(within(card).getByText('Verified')).toBeDefined();
    expect(within(card).getByText('42 ms', { exact: false })).toBeDefined();
    expect(within(card).getByText('312 repositories')).toBeDefined();
    expect(within(card).getByText('128 signed events synchronized')).toBeDefined();
    expect(within(card).getByText(/API remaining: 4900/)).toBeDefined();
    expect(within(card).getByText('Event sync')).toBeDefined();
    expect(within(card).queryByText('Polling')).toBeNull();

    const manage = within(card).getByRole('button', { name: 'Manage' });
    fireEvent.click(manage);
    const dialog = screen.getByRole('dialog', { name: 'Manage GitHub App' });
    expect(within(dialog).getByText('GitHub App sre-triage')).toBeDefined();
    expect(within(dialog).getByText(/channel is configured/i)).toBeDefined();
    expect(within(dialog).getByLabelText('Smee channel URL')).toBeDefined();
    expect(within(dialog).queryByLabelText('Private key (PEM)')).toBeNull();
    expect(within(dialog).queryByLabelText('Webhook secret')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(document.activeElement).toBe(manage));

    fireEvent.click(within(card).getByText('More actions'));
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const confirmation = within(card).getByRole('alertdialog', { name: 'Disconnect GitHub' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm disconnect' }));
    await waitFor(() => expect(h.disconnectGitHub).toHaveBeenCalledTimes(1));
  });

  test('promotes authenticated event failures to the connector status', () => {
    h.connectors = [
      {
        type: 'github',
        settings: { appId: 'Iv1.saved', installationId: '101' },
        enabled: true,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-22T01:00:00.000Z',
          lastSuccessAt: '2026-08-22T01:00:00.000Z',
          failureCategory: null,
        },
        events: {
          lastAttemptAt: '2026-08-22T01:01:00.000Z',
          lastSuccessAt: '2026-08-22T01:00:00.000Z',
          count: 1,
          failureCategory: 'signature_mismatch',
        },
      },
    ];

    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'github' });
    expect(within(card).getByText('Event sync failing')).toBeDefined();
    expect(within(card).getByText('Failure: signature mismatch')).toBeDefined();
  });

  test('shows Prometheus Alertmanager delivery health separately from metrics access', () => {
    h.connectors = [
      {
        type: 'prometheus',
        settings: {
          baseUrl: 'https://prometheus.example.com',
          authType: 'none',
          eventTransport: 'smee',
          alertChannel: 'C07ALERTS',
        },
        enabled: true,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-26T01:00:00.000Z',
          lastSuccessAt: '2026-08-26T01:00:00.000Z',
          failureCategory: null,
        },
        events: {
          lastAttemptAt: '2026-08-26T01:01:00.000Z',
          lastSuccessAt: null,
          count: 0,
          failureCategory: 'invalid_payload',
        },
      },
    ];

    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'prometheus' });
    expect(within(card).getByText('Alert delivery failing')).toBeDefined();
    expect(within(card).getByText('Metrics access')).toBeDefined();
    expect(within(card).getByText('Alert lifecycle')).toBeDefined();
    expect(within(card).getByText('Failure: invalid payload')).toBeDefined();
    expect(within(card).queryByText('Polling')).toBeNull();
  });

  test('makes metrics-only Prometheus configuration visibly incomplete', () => {
    h.connectors = [
      {
        type: 'prometheus',
        settings: {
          baseUrl: 'http://127.0.0.1:9090',
          authType: 'none',
          eventTransport: 'none',
        },
        enabled: true,
        credentialConfigured: true,
        verification: {
          lastAttemptAt: '2026-08-27T01:00:00.000Z',
          lastSuccessAt: '2026-08-27T01:00:00.000Z',
          failureCategory: null,
        },
        events: {
          lastAttemptAt: null,
          lastSuccessAt: null,
          count: 0,
          failureCategory: null,
        },
      },
    ];

    render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: 'prometheus' });
    expect(within(card).getByText('Partially configured')).toBeDefined();
    expect(within(card).getByText('Metrics access')).toBeDefined();
    expect(within(card).getByText('Alert lifecycle')).toBeDefined();
    expect(within(card).getByText('Not configured')).toBeDefined();
    expect(within(card).getByText(/only arrive indirectly through subscribed chat/i)).toBeDefined();
  });

  test('keeps Prometheus pending until the first authenticated Alertmanager event', () => {
    const connector: ConnectorFixture = {
      type: 'prometheus',
      settings: {
        baseUrl: 'https://prometheus.example.com',
        authType: 'none',
        eventTransport: 'smee',
        alertChannel: 'C07ALERTS',
      },
      enabled: true,
      credentialConfigured: true,
      verification: {
        lastAttemptAt: '2026-08-27T01:00:00.000Z',
        lastSuccessAt: '2026-08-27T01:00:00.000Z',
        failureCategory: null,
      },
      events: {
        lastAttemptAt: null,
        lastSuccessAt: null,
        count: 0,
        failureCategory: null,
      },
    };
    h.connectors = [connector];

    const { rerender } = render(<ConnectorsPanel />);
    expect(screen.getByText('Awaiting alert event')).toBeDefined();

    connector.events = {
      lastAttemptAt: '2026-08-27T01:05:00.000Z',
      lastSuccessAt: '2026-08-27T01:05:00.000Z',
      count: 1,
      failureCategory: null,
    };
    rerender(<ConnectorsPanel />);
    expect(screen.getByText('Verified')).toBeDefined();
    expect(screen.queryByText('Awaiting alert event')).toBeNull();
  });
});
