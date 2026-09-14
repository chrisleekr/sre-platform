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

vi.mock('../../lib/connector-delivery', async () => {
  const { prepareTestDelivery } = await import('../../test/connector-delivery');
  return {
    prepareConnectorDelivery: (
      _api: unknown,
      _auth: unknown,
      _type: unknown,
      input: Parameters<typeof prepareTestDelivery>[0],
    ) => prepareTestDelivery(input),
  };
});

type ConnectorFixture = Omit<ConnectorSummary, 'id' | 'name'> &
  Partial<Pick<ConnectorSummary, 'id' | 'name'>>;

const h = vi.hoisted(() => ({
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
  const route = '/w/connectors?view=catalog';
  return renderUI(ui, {
    wrapper: ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
    ),
  });
}

let dialogMethods: ReturnType<typeof installDialogMethods>;

const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

beforeEach(() => {
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
  test('connects a dedicated GitHub App with explicit issue-write scope and returns focus at 360px', async () => {
    h.discoverGitHubInstallations.mockResolvedValue([
      {
        id: 101,
        accountLogin: 'acme',
        accountType: 'Organization',
        repositorySelection: 'selected',
        permissions: {
          contents: 'read',
          pull_requests: 'read',
          actions: 'read',
          deployments: 'read',
          issues: 'write',
        },
        writePermissions: ['issues'],
        appSlug: 'sre-triage',
      },
    ]);
    h.saveGitHub.mockResolvedValue({
      connectorId: '00000000-0000-4000-8000-000000000042',
      webhookPath: '/webhooks/github/opaque-key',
      relayStatus: 'connected',
    });
    h.testGitHub.mockResolvedValue({
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: {
        readOnlyApp: false,
        allowedPermissions: true,
        canEnumerateRepositories: true,
        hasRepositories: true,
        canReadRepository: true,
        canReadDeployments: true,
        canReadContents: true,
        canReadPullRequests: true,
        canReadActions: true,
        webhookSecretConfigured: true,
      },
      details: { repositoryCount: 312 },
      warnings: [],
      rateLimitRemaining: 4900,
      enabled: true,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    render(<ConnectorsPanel />);
    const trigger = screen.getByRole('button', { name: 'Add GitHub App' });

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Connect GitHub App' });
    expect(dialog.className).toMatch(/w-\[calc\(100%-2rem\)\]/);
    expect(within(dialog).getByText(/Contents is required/i)).toBeDefined();
    expect(within(dialog).getByText(/installation, not a repository/i)).toBeDefined();
    fireEvent.click(within(dialog).getByLabelText(/Existing dedicated App/i));
    fireEvent.change(within(dialog).getByLabelText('Smee channel URL'), {
      target: { value: 'https://smee.io/existing-app' },
    });
    const privateKey = within(dialog).getByLabelText('Private key (PEM)');
    expect(privateKey.getAttribute('autocomplete')).toBe('new-password');
    expect(privateKey.getAttribute('class')).toMatch(/min-w-0/);
    fireEvent.change(within(dialog).getByLabelText('GitHub App ID or client ID'), {
      target: { value: 'Iv1.browser' },
    });
    fireEvent.change(privateKey, { target: { value: 'private-key-browser-only' } });
    fireEvent.change(within(dialog).getByLabelText('Webhook secret'), {
      target: { value: 'webhook-secret-browser-only' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check existing App' }));

    expect(await within(dialog).findByLabelText('Installation')).toBeDefined();
    expect(within(dialog).getByText('Required: Contents')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review repository coverage' }));
    expect(within(dialog).getByText(/No repository selection is required/i)).toBeDefined();
    expect(within(dialog).getByText(/Catalog every granted repository/i)).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Allow confirmed issue changes' }),
    );
    fireEvent.change(within(dialog).getByLabelText('Repositories allowed for issue changes'), {
      target: { value: 'acme/app' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review connection' }));
    expect(
      within(dialog).getByText(/saves the connection disabled until those checks pass/i),
    ).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save, sync, and verify' }));

    expect(
      await within(dialog).findByText(
        'GitHub code access verified and repository catalog synchronized.',
      ),
    ).toBeDefined();
    expect(within(dialog).getByText('312 repositories synchronized')).toBeDefined();
    expect(within(dialog).getByText('✓ App permissions match the configured policy')).toBeDefined();
    expect(h.discoverGitHubInstallations).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      { appId: 'Iv1.browser', credential: 'private-key-browser-only' },
    );
    expect(h.saveGitHub).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      setupId: '00000000-0000-4000-8000-000000000099',
      name: 'GitHub',
      settings: {
        appId: 'Iv1.browser',
        issueManagement: { enabled: true, repositories: ['acme/app'] },
        installationId: '101',
        accountLogin: 'acme',
        repositorySelection: 'selected',
        permissions: {
          contents: 'read',
          pull_requests: 'read',
          actions: 'read',
          deployments: 'read',
          issues: 'write',
        },
        appSlug: 'sre-triage',
        eventTransport: 'smee',
        smeeUrl: 'https://smee.io/existing-app',
      },
      credential: 'private-key-browser-only',
      webhookSecret: 'webhook-secret-browser-only',
    });
    expect(within(dialog).getByText(/Local Smee relay connected\./)).toBeDefined();
    expect(within(dialog).getByText(/does not prove authenticated GitHub delivery/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Connections' }).closest('[tabindex="-1"]'),
      ).toBe(document.activeElement),
    );
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('connects ArgoCD through least-privilege scope, write-only TLS/token, and focus return', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    h.fetchArgoCdAccess.mockResolvedValue({
      instructions: {
        project: 'payments',
        role: 'sre-platform',
        identity: 'proj:payments:sre-platform',
        policies: ['p, proj:payments:sre-platform, applications, get, payments/*, allow'],
        tokenCommand: 'argocd proj role create-token payments sre-platform',
      },
      commands: {
        createRole: 'argocd proj role create payments',
        addPolicies: 'argocd proj role add-policy payments',
        install: 'argocd proj role create payments',
        uninstall: 'argocd proj role delete payments',
      },
    });
    h.saveArgoCd.mockResolvedValue({
      connectorId: '00000000-0000-4000-8000-000000000043',
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
    render(<ConnectorsPanel />);
    const trigger = screen.getByRole('button', { name: 'Add Argo CD' });

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Connect Argo CD' });
    expect(dialog.className).toMatch(/w-\[calc\(100%-2rem\)\]/);
    fireEvent.click(within(dialog).getByLabelText('Pin a CA certificate'));
    const ca = within(dialog).getByLabelText('CA certificate (PEM)');
    expect(ca).toHaveProperty('value', '');
    fireEvent.change(ca, { target: { value: 'CA PEM browser only' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText(/Each project gets its own credential/)).toBeDefined();
    fireEvent.change(within(dialog).getByLabelText('Argo CD project 1'), {
      target: { value: 'payments' },
    });
    fireEvent.change(within(dialog).getByLabelText('Argo CD application 1.1'), {
      target: { value: 'checkout' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    expect(within(dialog).getByText(/Neither option edits global Argo CD RBAC/)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Generate dedicated access' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate access commands' }));
    expect(await within(dialog).findByText(/argocd proj role create payments/)).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Copy payments create role command' }),
    );
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Copy payments read policies command' }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy payments token command' }));
    fireEvent.click(within(dialog).getByText('Uninstall access later'));
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Copy payments uninstall command' }),
    );
    expect(writeText.mock.calls).toEqual([
      ['argocd proj role create payments'],
      ['argocd proj role add-policy payments'],
      ['argocd proj role create-token payments sre-platform'],
      ['argocd proj role delete payments'],
    ]);
    const token = within(dialog).getByLabelText('Argo CD token for payments');
    expect(token.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.change(token, { target: { value: 'argocd-token-browser-only' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify all projects' }));

    expect(
      await within(dialog).findByText('Argo CD connector enabled for every project.'),
    ).toBeDefined();
    expect(within(dialog).getByText('Project-role identity: verified')).toBeDefined();
    expect(within(dialog).getByText('Required application and log reads: verified')).toBeDefined();
    expect(within(dialog).getByText('Known over-grant samples: passed')).toBeDefined();
    expect(h.saveArgoCd).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      name: 'Argo CD',
      settings: {
        baseUrl: 'https://argocd.example.com',
        accessRole: expect.stringMatching(/^sre-platform-[0-9a-f]{8}$/),
        applicationsInAnyNamespace: false,
        projects: [{ project: 'payments', applications: [{ name: 'checkout' }] }],
        caCert: 'CA PEM browser only',
      },
      credentials: [{ project: 'payments', token: 'argocd-token-browser-only' }],
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Connections' }).closest('[tabindex="-1"]'),
      ).toBe(document.activeElement),
    );
  });
});
