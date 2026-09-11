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
  const route = '/w/connectors';
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
  test('an existing Kubernetes card reopens the full setup lifecycle and restores its trigger', async () => {
    h.connectors = [
      {
        type: 'kubernetes',
        settings: {
          name: 'homelab-v2',
          apiUrl: 'https://192.168.1.202:6443',
          namespace: '',
          caConfigured: true,
        },
        enabled: true,
        credentialConfigured: true,
      },
    ];
    h.testKubernetes.mockResolvedValue({
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: { canListPods: true, secretsDenied: true },
      warnings: [],
      enabled: true,
    });
    h.disconnectKubernetes.mockResolvedValue(undefined);
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    const card = screen.getByRole('article', { name: /kubernetes/i });
    const trigger = within(card).getByRole('button', { name: 'Manage' });

    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Manage Kubernetes' });
    expect(within(dialog).getByRole('list', { name: 'Setup progress' })).toBeDefined();
    expect(within(dialog).getByLabelText(/cluster name/i)).toHaveProperty('value', 'homelab-v2');
    expect(within(dialog).getByLabelText(/api server url/i)).toHaveProperty(
      'value',
      'https://192.168.1.202:6443',
    );
    expect(within(dialog).getByText(/stored PEM is never prefilled/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: 'Manage Kubernetes' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));

    fireEvent.click(within(card).getByRole('button', { name: 'Retest' }));
    await waitFor(() => expect(h.testKubernetes).toHaveBeenCalledTimes(1));
    fireEvent.click(within(card).getByText('More actions'));
    fireEvent.click(within(card).getByRole('button', { name: 'Disconnect' }));
    const confirmation = within(card).getByRole('alertdialog', {
      name: 'Disconnect Kubernetes',
    });
    expect(within(confirmation).getByText(/does not remove provider-side RBAC/i)).toBeDefined();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm disconnect' }));
    await waitFor(() => expect(h.disconnectKubernetes).toHaveBeenCalledTimes(1));
  });

  test('closing restores the exact Kubernetes trigger when a later Retry control exists', async () => {
    h.connectors = [{ type: 'kubernetes', settings: {}, enabled: true }];
    h.error = true;
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Review setup' }));
    const trigger = within(screen.getByRole('article', { name: /kubernetes/i })).getByRole(
      'button',
      { name: 'Manage' },
    );
    expect(screen.getByRole('button', { name: /retry/i })).toBeDefined();
    fireEvent.click(trigger);

    fireEvent.click(
      within(screen.getByRole('dialog', { name: /manage kubernetes/i })).getByRole('button', {
        name: /close/i,
      }),
    );

    expect(h.refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog', { name: /manage kubernetes/i })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('uses a responsive operational row with separate access and activity', () => {
    h.connectors = [{ type: 'kubernetes', settings: { namespace: 'payments' }, enabled: true }];
    const { container } = render(<ConnectorsPanel />);
    expect(container.querySelector('article')?.className).toMatch(/lg:grid-cols-/);
    expect(screen.getAllByText('Access').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Data activity').length).toBeGreaterThan(0);
    expect(screen.getByRole('article', { name: /kubernetes/i }).className).toMatch(/min-w-0/);
  });

  test('uses one page heading and preserves the Add Kubernetes action (C7)', () => {
    render(<ConnectorsPanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Connections' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDefined();
    expect(screen.queryByRole('button', { name: /add kubernetes/i })).toBeNull();
  });

  test('renders a reserved, polite first-load state (C1)', () => {
    h.loading = true;
    const { container } = render(<ConnectorsPanel />);

    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading connections/i);
  });

  test('keeps saved connectors visible and announces an explicit refresh', () => {
    h.connectors = [{ type: 'kubernetes', settings: {}, enabled: true }];
    const view = render(<ConnectorsPanel />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('1 of 1 connections');

    h.loading = true;
    view.rerender(<ConnectorsPanel />);

    expect(screen.getByRole('article', { name: /kubernetes/i })).toBeDefined();
    expect(screen.getAllByRole('status')).toHaveLength(2);
    expect(screen.getByText('Refreshing connections…')).toBeDefined();
    expect(screen.queryByText('Loading connectors…')).toBeNull();
  });

  test('explains every available connector before the first setup (C2)', () => {
    render(<ConnectorsPanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    expect(screen.getByRole('heading', { name: 'Add connection' })).toBeDefined();
    expect(screen.getByText(/live pods, events, logs, nodes/i)).toBeDefined();
    expect(screen.getByText(/application sync, health, revision/i)).toBeDefined();
    expect(
      screen.getByText(/Prometheus metrics for investigation plus exact Alertmanager/i),
    ).toBeDefined();
    expect(screen.getByText(/on-demand uptime tests, history, alerts/i)).toBeDefined();
    expect(screen.queryByText('Not configured')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add Slack' })).toBeDefined();
  });

  test('renders one specific error and retries through the existing hook (C3, C6)', () => {
    h.error = true;
    render(<ConnectorsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(
      /could not refresh evidence connections/i,
    );
    expect(screen.queryByText('Connect your first tool')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });

  test('keeps configured connectors visible when a refresh fails (C3, C6)', () => {
    h.connectors = [{ type: 'kubernetes', settings: { apiUrl: 'https://k8s' }, enabled: true }];
    h.error = true;
    render(<ConnectorsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByText('Kubernetes').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Your connections' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});
