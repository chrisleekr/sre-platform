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
  test.each<{
    type: string;
    settings: Record<string, unknown>;
    allowed: string[];
    forbidden: string[];
  }>([
    {
      type: 'github',
      settings: {
        accountLogin: 'acme',
        appSlug: 'sre-platform-acme',
        appId: '901',
        repo: 'must-not-render/repository',
        token: 'opaque-github-secret',
      },
      allowed: ['acme', 'sre-platform-acme', '901'],
      forbidden: ['must-not-render/repository', 'opaque-github-secret'],
    },
    {
      type: 'gitlab',
      settings: {
        projectId: 71,
        service: 'checkout',
        baseUrl: 'https://gitlab-user:gitlab-pass@gitlab.example.com/private?token=gitlab-query',
        caCert: 'opaque-gitlab-ca',
        unknown: 'opaque-gitlab-secret',
      },
      allowed: ['71', 'checkout', 'gitlab.example.com'],
      forbidden: [
        'gitlab-user',
        'gitlab-pass',
        '/private',
        'gitlab-query',
        'opaque-gitlab-ca',
        'opaque-gitlab-secret',
      ],
    },
    {
      type: 'prometheus',
      settings: {
        baseUrl: 'https://prom-user:prom-pass@prometheus.example.com:9090/private?token=prom-query',
        caCert: 'opaque-prometheus-ca',
        insecureSkipTLSVerify: true,
        unknown: 'opaque-prometheus-secret',
      },
      allowed: ['prometheus.example.com:9090', 'CA configured', 'TLS verification disabled'],
      forbidden: [
        'prom-user',
        'prom-pass',
        '/private',
        'prom-query',
        'opaque-prometheus-ca',
        'opaque-prometheus-secret',
      ],
    },
    {
      type: 'argocd',
      settings: {
        baseUrl: 'https://argo-user:argo-pass@argocd.example.com/apps?token=argo-query',
        caCert: 'opaque-argocd-ca',
        unknown: 'opaque-argocd-secret',
      },
      allowed: ['argocd.example.com', 'CA configured'],
      forbidden: [
        'argo-user',
        'argo-pass',
        '/apps',
        'argo-query',
        'opaque-argocd-ca',
        'opaque-argocd-secret',
      ],
    },
    {
      type: 'grafana',
      settings: {
        baseUrl: 'https://grafana-user:grafana-pass@grafana.example.com/dashboards?key=query',
        caCert: 'opaque-grafana-ca',
        unknown: 'opaque-grafana-secret',
      },
      allowed: ['grafana.example.com', 'CA configured'],
      forbidden: [
        'grafana-user',
        'grafana-pass',
        '/dashboards',
        'key=query',
        'opaque-grafana-ca',
        'opaque-grafana-secret',
      ],
    },
  ])('projects only allowlisted $type summary values', ({ type, settings, allowed, forbidden }) => {
    h.connectors = [{ type, settings, enabled: true }];

    render(<ConnectorsPanel />);

    const card = screen.getByRole('article', {
      name: new RegExp(type, 'i'),
    });
    for (const value of allowed) expect(within(card).getByText(value)).toBeDefined();
    const text = card.textContent ?? '';
    for (const value of forbidden) expect(text).not.toContain(value);
  });

  test('renders the configured connectors with their enabled state', () => {
    h.connectors = [
      { type: 'kubernetes', settings: { apiUrl: 'https://k8s' }, enabled: true },
      { type: 'datadog', settings: {}, enabled: false },
    ];
    render(<ConnectorsPanel />);
    expect(screen.getAllByText('Kubernetes').length).toBeGreaterThan(0);
    expect(screen.getByText('datadog')).toBeDefined();
    expect(screen.getByText('Not verified')).toBeDefined();
    expect(screen.getByText(/disabled/i)).toBeDefined();
  });

  test('shows multiple independently named instances and keeps the add action available', () => {
    h.testKubernetes.mockReturnValue(new Promise(() => {}));
    h.connectors = [
      {
        id: '00000000-0000-4000-8000-000000000101',
        name: 'Production cluster',
        type: 'kubernetes',
        settings: { apiUrl: 'https://production.k8s.example.com' },
        enabled: true,
      },
      {
        id: '00000000-0000-4000-8000-000000000102',
        name: 'Staging cluster',
        type: 'kubernetes',
        settings: { apiUrl: 'https://staging.k8s.example.com' },
        enabled: false,
      },
    ];

    render(<ConnectorsPanel />);

    expect(screen.getByRole('button', { name: 'Add connection' })).toBeDefined();
    const production = screen.getByRole('article', { name: 'Production cluster' });
    const staging = screen.getByRole('article', { name: 'Staging cluster' });
    expect(within(production).getByText('production.k8s.example.com')).toBeDefined();
    expect(within(production).getByText('Not verified')).toBeDefined();
    expect(within(staging).getByText('staging.k8s.example.com')).toBeDefined();
    expect(within(staging).getByText('Disabled')).toBeDefined();
    expect(within(staging).getByRole('button', { name: 'View details' })).toBeDefined();
    fireEvent.click(within(production).getByRole('button', { name: 'Review setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retest' }));
    expect(screen.getByRole('button', { name: 'Testing…' })).toBeDefined();
    expect(h.testKubernetes).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      '00000000-0000-4000-8000-000000000101',
    );
  });

  test('renders semantic cards with allowlisted summaries and exact configuration state (261-C1)', () => {
    h.connectors = [
      {
        type: 'kubernetes',
        settings: {
          name: 'production-cluster',
          namespace: 'payments',
          apiUrl:
            'https://api-user:url-secret@api.k8s.example.com:6443/private/path?token=query-secret#fragment-secret',
          caCert: '-----BEGIN CERTIFICATE-----\nopaque-ca-material',
          insecureSkipTLSVerify: true,
          arbitrarySecret: 'opaque-setting-secret',
        },
        enabled: true,
      },
      {
        type: 'datadog',
        settings: { site: 'datadoghq.eu', apiKey: 'opaque-api-key' },
        enabled: false,
      },
    ];

    const { container } = render(<ConnectorsPanel />);
    const kubernetes = screen.getByRole('article', { name: /kubernetes/i });
    const datadog = screen.getByRole('article', { name: /datadog/i });

    expect(within(kubernetes).getByText('production-cluster')).toBeDefined();
    expect(within(kubernetes).getByText('payments')).toBeDefined();
    expect(within(kubernetes).getByText('api.k8s.example.com:6443')).toBeDefined();
    expect(within(kubernetes).getByText('CA configured')).toBeDefined();
    expect(within(kubernetes).getByText('TLS verification disabled')).toBeDefined();
    expect(within(kubernetes).getByText('Not verified')).toBeDefined();
    expect(within(datadog).getByText('datadoghq.eu')).toBeDefined();
    expect(within(datadog).getByText('Disabled')).toBeDefined();

    const text = container.textContent ?? '';
    for (const forbidden of [
      'api-user',
      'url-secret',
      '/private/path',
      'query-secret',
      'fragment-secret',
      'BEGIN CERTIFICATE',
      'opaque-ca-material',
      'opaque-setting-secret',
      'opaque-api-key',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  test('does not enumerate opaque settings for an unrecognized connector summary', () => {
    h.connectors = [
      {
        type: 'custom',
        settings: { token: 'must-not-render', endpoint: 'https://user:pass@example.com/private' },
        enabled: false,
      },
    ];

    const { container } = render(<ConnectorsPanel />);
    const card = screen.getByRole('article', { name: /custom/i });

    expect(within(card).getByText('Settings configured')).toBeDefined();
    expect(container.textContent).not.toContain('must-not-render');
    expect(container.textContent).not.toContain('user:pass');
  });

  test('the Add Kubernetes button opens the wizard', () => {
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const trigger = screen.getByRole('button', { name: /add kubernetes/i });
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: /connect kubernetes/i });
    expect(dialogMethods.showModal).toHaveBeenCalledTimes(1);
    expect(within(dialog).getByLabelText(/api server url/i)).toBeDefined();
    expect(within(dialog).getByRole('heading', { name: /connect kubernetes/i })).toBeDefined();
    expect(dialog.className).toMatch(/max-w-/);
  });

  test('connects GitLab group-wide without a project picker and returns focus', async () => {
    h.discoverGitLab.mockResolvedValue({
      group: {
        id: 7,
        name: 'Platform',
        fullPath: 'platform',
        webUrl: 'https://gitlab.example.com/groups/platform',
      },
      projects: [
        {
          id: 42,
          name: 'checkout',
          pathWithNamespace: 'platform/checkout',
          webUrl: 'https://gitlab.example.com/platform/checkout',
          archived: false,
        },
      ],
    });
    h.saveGitLab.mockResolvedValue({
      connectorId: '00000000-0000-4000-8000-000000000041',
      webhookPath: '/webhooks/gitlab/opaque-key',
    });
    h.testGitLab.mockResolvedValue({
      status: 'healthy',
      reachable: true,
      authorized: true,
      checks: {
        canReadGroup: true,
        canEnumerateProjects: true,
        hasProjects: true,
        canReadProject: true,
        canReadCode: true,
        canReadPipelines: true,
        canReadDeployments: true,
      },
      details: { group: 'platform', projectCount: 1, eventSync: 'none' },
      warnings: [],
      enabled: true,
    });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    render(<ConnectorsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }));
    const trigger = screen.getByRole('button', { name: 'Add GitLab' });

    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Connect GitLab' });
    const token = within(dialog).getByLabelText(/read-only access token/i);
    expect(token.getAttribute('type')).toBe('password');
    fireEvent.change(within(dialog).getByLabelText('GitLab URL'), {
      target: { value: 'https://gitlab.example.com/gitlab' },
    });
    fireEvent.change(within(dialog).getByLabelText('Top-level group full path'), {
      target: { value: 'platform' },
    });
    fireEvent.change(token, { target: { value: 'glpat-browser-only' } });
    expect(within(dialog).getAllByText(/read_api/).length).toBeGreaterThan(0);
    expect(within(dialog).getByRole('link', { name: 'Group token guide' })).toBeDefined();
    expect(within(dialog).getByRole('link', { name: 'Service account fallback' })).toBeDefined();
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Check access and discover projects' }),
    );

    expect(await within(dialog).findByText('1 project discovered')).toBeDefined();
    expect(within(dialog).queryByLabelText('Project')).toBeNull();
    expect(dialog.className).toMatch(/w-\[calc\(100%-2rem\)\]/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure event sync' }));
    expect(within(dialog).getByLabelText(/configure later/i)).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
    expect(within(dialog).getByText('Read-only API checks')).toBeDefined();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save and verify' }));

    expect(
      await within(dialog).findByText(/Read access verified\. Catalog: 1 projects/),
    ).toBeDefined();
    expect(within(dialog).getByText(/event sync is not configured/i)).toBeDefined();
    expect(h.discoverGitLab).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      baseUrl: 'https://gitlab.example.com/gitlab',
      groupPath: 'platform',
      credential: 'glpat-browser-only',
    });
    expect(h.saveGitLab).toHaveBeenCalledWith(expect.any(String), expect.any(Function), {
      name: 'GitLab',
      settings: {
        baseUrl: 'https://gitlab.example.com/gitlab',
        groupId: 7,
        groupPath: 'platform',
        groupName: 'Platform',
        eventTransport: 'none',
        hookScope: 'projects',
      },
      credential: 'glpat-browser-only',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Finish' }));
    await waitFor(() =>
      expect(
        screen.getByRole('heading', { level: 1, name: 'Connections' }).closest('[tabindex="-1"]'),
      ).toBe(document.activeElement),
    );
    expect(h.refetch).toHaveBeenCalledTimes(1);
  });
});
