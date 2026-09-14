// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent, within } from '@testing-library/react';
import type { Incident } from '../../lib/types';
import type { BlastRadius, TopologyGraph } from '../../lib/topology';
import type { InvestigationSubject } from '../../lib/investigations';
import { installMatchMedia } from './match-media.fixture';

const graph: TopologyGraph = {
  nodes: [
    {
      name: 'checkout',
      team: null,
      criticality: null,
      lastDeployAt: null,
      recentDeploys: [],
    },
    {
      name: 'payments',
      team: null,
      criticality: null,
      lastDeployAt: null,
      recentDeploys: [],
    },
  ],
  edges: [
    { upstream: 'checkout', downstream: 'payments', syncType: 'sync', circuitBreaker: false },
  ],
};

const h = vi.hoisted(() => ({
  incidents: [] as Incident[],
  fetchBlastRadius: vi.fn(),
  graph: null as TopologyGraph | null,
  loading: false,
  error: false,
  activeInvestigations: new Map<string, string>(),
  investigationSubjects: [] as InvestigationSubject[],
  refetch: vi.fn(),
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'tok' }) }),
}));
vi.mock('../../lib/useIncidents', () => ({
  useIncidents: () => ({ incidents: h.incidents, loading: false, error: false }),
}));
vi.mock('../../lib/useTopology', () => ({
  useTopology: () => ({
    graph: { ...(h.graph ?? graph), incidents: h.incidents },
    loading: h.loading,
    error: h.error,
    refetch: h.refetch,
  }),
  fetchBlastRadius: h.fetchBlastRadius,
  saveTopologyService: vi.fn(async () => {}),
  saveTopologyDependency: vi.fn(async () => {}),
}));
vi.mock('../../lib/useInvestigationWorkspaces', () => ({
  useInvestigationWorkspaces: (args: { subjects: InvestigationSubject[] }) => {
    h.investigationSubjects = args.subjects;
    return h.activeInvestigations;
  },
}));

import { TopologyPanel } from '../TopologyPanel';
import { discoveryFixture } from './topology-discovery.fixture';
import './topology-map-browser.fixture';
vi.mock('elkjs/lib/elk-api.js', async () => {
  const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
  return {
    default: class extends ELK {
      constructor() {
        super({ algorithms: ['layered'] });
      }
      override terminateWorker() {}
    },
  };
});

const BLAST: BlastRadius = {
  service: 'payments',
  mapped: true,
  dependents: {
    direct: [{ name: 'checkout', criticality: null, team: null, hops: 1 }],
    indirect: [],
    insulated: [],
  },
  suspects: [],
  truncated: false,
};

function incident(over: Partial<Incident>): Incident {
  return {
    id: 'i1',
    service: 'payments',
    severity: 'sev2',
    status: 'mitigated',
    investigationStatus: 'gathering',
    lifecycleVersion: 1,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  installMatchMedia(false);
  h.fetchBlastRadius.mockResolvedValue(BLAST);
});

afterEach(() => {
  h.fetchBlastRadius.mockReset();
  h.incidents = [];
  h.graph = null;
  h.loading = false;
  h.error = false;
  h.activeInvestigations = new Map();
  h.investigationSubjects = [];
  h.refetch.mockReset();
  vi.unstubAllGlobals();
});

describe('TopologyPanel blast-radius overlay', () => {
  test('automatic discovery is primary and catalog correction is a secondary, optional workflow', async () => {
    h.graph = { nodes: [], edges: [], discovery: discoveryFixture() };
    render(<TopologyPanel />);
    expect(screen.getByRole('region', { name: 'Discovered topology map' })).toBeTruthy();
    await screen.findByRole('group', { name: 'Topology relationships' });
    const summary = screen.getByText('Catalog and corrections');
    expect(summary.closest('details')?.open).toBe(false);
    expect(screen.queryByRole('button', { name: 'Edit catalog' })).toBeNull();
    fireEvent.click(summary);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Edit catalog' })).toBeTruthy());
  });
  test('selected-service impact refreshes after relationship changes and reports retryable errors', async () => {
    h.fetchBlastRadius
      .mockRejectedValueOnce(new Error('Impact request unavailable'))
      .mockResolvedValue(BLAST);
    const view = render(<TopologyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'payments, unknown' }));
    expect(await screen.findByText('Impact request unavailable')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Retry impact analysis' }));
    await waitFor(() => expect(screen.getByText('Synchronous exposure (1)')).toBeDefined());
    const calls = h.fetchBlastRadius.mock.calls.length;
    h.graph = { ...graph, edges: [] };
    view.rerender(<TopologyPanel />);
    await waitFor(() => expect(h.fetchBlastRadius.mock.calls.length).toBe(calls + 1));
  });

  test('uses confirmed mappings instead of a transport label and lets the overlay be disabled', async () => {
    h.incidents = [incident({ service: 'slack:C-TEST' })];
    h.graph = { ...graph, incidentMappings: [{ incidentId: 'i1', services: ['payments'] }] };
    render(<TopologyPanel />);
    expect(h.fetchBlastRadius).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Incident overlay' }), {
      target: { value: 'i1' },
    });
    await waitFor(() => expect(h.fetchBlastRadius.mock.calls[0]?.[2]).toBe('payments'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Incident overlay' }), {
      target: { value: '' },
    });
    await waitFor(() => expect(screen.queryByLabelText('Dependency impact')).toBeNull());
  });

  test('does not calculate impact for an unresolved conversation identity', () => {
    h.incidents = [incident({ service: 'slack:C-TEST' })];
    h.graph = { ...graph, incidentMappings: [{ incidentId: 'i1', services: [] }] };
    render(<TopologyPanel />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Incident overlay' }), {
      target: { value: 'i1' },
    });
    expect(
      screen.getByText(/Dependency impact is unavailable until an affected service is linked/i),
    ).toBeDefined();
    expect(h.fetchBlastRadius).not.toHaveBeenCalled();
  });
  test('fetches and applies the blast radius for the active incident', async () => {
    h.fetchBlastRadius.mockResolvedValue(BLAST);
    h.incidents = [incident({ service: 'payments', status: 'mitigated' })];
    const { container } = render(<TopologyPanel />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Incident overlay' }), {
      target: { value: 'i1' },
    });
    await waitFor(() => expect(h.fetchBlastRadius).toHaveBeenCalled());
    expect(h.fetchBlastRadius.mock.calls[0]?.[2]).toBe('payments');
    await waitFor(() =>
      expect(container.querySelector('[data-highlight="affected"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-highlight="direct"]')).not.toBeNull();
  });

  test('no fetch and no overlay when there is no active incident', async () => {
    h.incidents = []; // none active
    const { container } = render(<TopologyPanel />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(h.fetchBlastRadius).not.toHaveBeenCalled();
    expect(container.querySelector('[data-highlight]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Incident overlay' })).toBeNull();
  });

  test('starts without an overlay, preserves incident order and clears rings when selection changes', async () => {
    installMatchMedia(false);
    h.incidents = [
      incident({ id: 'resolved', service: 'ignored', status: 'resolved' }),
      incident({ id: 'payments-incident', service: 'payments', status: 'mitigated' }),
      incident({ id: 'checkout-incident', service: 'checkout', status: 'open' }),
    ];
    let resolvePayments: ((blast: BlastRadius) => void) | undefined;
    let resolveCheckout: ((blast: BlastRadius) => void) | undefined;
    h.fetchBlastRadius
      .mockImplementationOnce(
        () =>
          new Promise<BlastRadius>((resolve) => {
            resolvePayments = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<BlastRadius>((resolve) => {
            resolveCheckout = resolve;
          }),
      );
    const { container } = render(<TopologyPanel />);
    const selector = screen.getByRole('combobox', {
      name: 'Incident overlay',
    }) as HTMLSelectElement;

    const activeValues = within(selector)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value)
      .filter(Boolean);
    expect(activeValues).toEqual(['payments-incident', 'checkout-incident']);
    expect(selector.value).toBe('');
    expect(h.fetchBlastRadius).not.toHaveBeenCalled();
    fireEvent.change(selector, { target: { value: 'payments-incident' } });
    await act(async () => {
      resolvePayments?.(BLAST);
    });
    await waitFor(() =>
      expect(container.querySelector('[data-highlight="affected"]')).not.toBeNull(),
    );

    fireEvent.change(selector, { target: { value: 'checkout-incident' } });

    expect(h.fetchBlastRadius.mock.calls.at(-1)?.[2]).toBe('checkout');
    expect(container.querySelector('[data-highlight]')).toBeNull();
    await act(async () => {
      resolveCheckout?.({
        ...BLAST,
        service: 'checkout',
        dependents: { ...BLAST.dependents, direct: [] },
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[data-highlight="affected"]')).not.toBeNull(),
    );
  });

  test('ignores a stale blast response after the incident selection changes', async () => {
    h.incidents = [
      incident({ id: 'payments-incident', service: 'payments', status: 'mitigated' }),
      incident({ id: 'checkout-incident', service: 'checkout', status: 'open' }),
    ];
    let resolvePayments: ((blast: BlastRadius) => void) | undefined;
    let resolveCheckout: ((blast: BlastRadius) => void) | undefined;
    h.fetchBlastRadius.mockImplementation(
      (_apiBaseUrl: string, _getToken: unknown, service: string) =>
        new Promise<BlastRadius>((resolve) => {
          if (service === 'payments') resolvePayments = resolve;
          if (service === 'checkout') resolveCheckout = resolve;
        }),
    );
    const { container } = render(<TopologyPanel />);
    const selector = screen.getByRole('combobox', { name: 'Incident overlay' });

    fireEvent.change(selector, { target: { value: 'payments-incident' } });
    fireEvent.change(selector, { target: { value: 'checkout-incident' } });
    expect(container.querySelector('[data-highlight]')).toBeNull();

    await act(async () => {
      resolvePayments?.(BLAST);
    });
    expect(container.querySelector('[data-highlight]')).toBeNull();

    await act(async () => {
      resolveCheckout?.({
        ...BLAST,
        service: 'checkout',
        dependents: { ...BLAST.dependents, direct: [] },
      });
    });
    await waitFor(() =>
      expect(container.querySelector('[data-highlight="affected"]')).not.toBeNull(),
    );
    const affected = container.querySelector('[data-highlight="affected"]');
    expect(affected?.parentElement?.getAttribute('data-node-group')).toBe('checkout');
    expect(container.querySelector('[data-node-group="payments"] [data-highlight]')).toBeNull();
  });
});

describe('TopologyPanel page states', () => {
  test('batches exact runtime subjects and opens the subject workspace instead of a service-matched incident', async () => {
    const subjectIncidentId = '22222222-2222-4222-8222-222222222222';
    h.graph = {
      nodes: [
        {
          ...graph.nodes[0]!,
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
        },
      ],
      edges: [],
    };
    h.incidents = [incident({ id: 'service-matched-only', service: 'checkout' })];
    h.fetchBlastRadius.mockResolvedValue({
      service: 'checkout',
      mapped: true,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
    });
    h.activeInvestigations = new Map([['topology_service:checkout', subjectIncidentId]]);
    window.history.replaceState({}, '', '/topology');

    render(<TopologyPanel />);

    expect(h.investigationSubjects).toEqual([{ kind: 'topology_service', service: 'checkout' }]);
    fireEvent.click(
      within(screen.getByRole('list', { name: 'Topology services' })).getByRole('button', {
        name: /checkout.*Active incident/i,
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open investigation' }));
    expect(window.location.pathname).toBe(`/w/incidents/${subjectIncidentId}`);
  });

  test('uses one page heading and a reserved, polite first-load status (C1, C7)', () => {
    h.loading = true;
    const { container } = render(<TopologyPanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Service topology' })).toBeDefined();
    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading topology/i);
  });

  test('renders one specific error without offering an unsafe retry (C3, C6)', () => {
    h.error = true;
    h.graph = { nodes: [], edges: [] };
    render(<TopologyPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load topology/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  test('shows a factual topology-empty state with one page heading and no blank SVG', () => {
    installMatchMedia(false);
    h.graph = { nodes: [], edges: [] };
    const { container } = render(<TopologyPanel />);

    expect(screen.getByText('No manual catalog entries')).toBeDefined();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Service topology' })).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  test('distinguishes a search with no matches from a genuinely empty topology', () => {
    installMatchMedia(true);
    render(<TopologyPanel />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search services' }), {
      target: { value: 'not-present' },
    });

    expect(screen.getByText('No services match your search.')).toBeDefined();
    expect(screen.queryByText('No manual catalog entries')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });
});

describe('TopologyPanel representations and detail selection', () => {
  test('starts an edge-less wide inventory in List while keeping Map available', async () => {
    installMatchMedia(false);
    h.graph = { ...graph, edges: [] };

    render(<TopologyPanel />);

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe(
        'true',
      ),
    );
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
  });

  test('shows live health, discovery provenance, filters, and unmapped incident context', async () => {
    installMatchMedia(true);
    h.graph = {
      nodes: [
        { ...graph.nodes[0]!, sources: ['kubernetes'] },
        { ...graph.nodes[1]!, sources: ['incident'] },
      ],
      edges: [],
      coverage: [
        {
          dataSourceId: '00000000-0000-4000-8000-000000000001',
          dataSourceName: 'Primary Kubernetes',
          state: 'complete',
          observedAt: new Date().toISOString(),
          lastSucceededAt: null,
        },
      ],
      runtimeBindings: [
        {
          id: 'binding',
          serviceName: 'checkout',
          connectorId: '00000000-0000-4000-8000-000000000001',
          namespace: 'checkout',
          labelKey: '',
          labelValue: '',
          environment: 'test',
          rationale: 'Confirmed',
          updatedAt: new Date().toISOString(),
        },
      ],
      infrastructure: [
        {
          dataSourceId: '00000000-0000-4000-8000-000000000001',
          dataSourceName: 'Primary Kubernetes',
          source: 'kubernetes',
          entityId: 'checkout/api-1',
          kind: 'pod',
          namespace: 'checkout',
          phase: 'Running',
          metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
          observedAt: new Date().toISOString(),
        },
        {
          dataSourceId: '00000000-0000-4000-8000-000000000001',
          dataSourceName: 'Primary Kubernetes',
          source: 'kubernetes',
          entityId: 'cluster/nodes',
          kind: 'node',
          metrics: {},
          error: 'node read denied',
          observedAt: new Date().toISOString(),
        },
      ],
    };
    h.incidents = [
      incident({ service: 'payments', title: 'Payments unavailable', status: 'mitigated' }),
    ];
    h.fetchBlastRadius.mockResolvedValue({ ...BLAST, mapped: false });

    render(<TopologyPanel />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Incident overlay' }), {
      target: { value: 'i1' },
    });
    const overview = screen.getByLabelText('Topology health overview');
    expect(within(overview).getByRole('button', { name: /Active incident\s*1/ })).toBeDefined();
    expect(within(overview).getByRole('button', { name: /Runtime healthy\s*1/ })).toBeDefined();
    expect(
      screen.getByText(/2 services · 0 registered relationships · source inventory: 1 pods/),
    ).toBeDefined();
    expect(screen.getByText('No service relationships are registered.')).toBeDefined();
    expect(screen.getByText('Runtime coverage is incomplete.')).toBeDefined();
    expect(screen.getByText(/cluster\/nodes: node read denied/)).toBeDefined();

    await waitFor(() =>
      expect(screen.getByText(/No unambiguous service identity is available/i)).toBeDefined(),
    );

    fireEvent.change(screen.getByRole('combobox', { name: 'Topology source' }), {
      target: { value: 'kubernetes' },
    });
    expect(screen.getByRole('button', { name: /checkout/i })).toBeDefined();
    expect(screen.queryByRole('button', { name: /payments/i })).toBeNull();
  });

  test.each([
    [true, 'List', 'Map'],
    [false, 'Map', 'List'],
  ] as const)('initial compact=%s defaults to %s', (compact, active, inactive) => {
    installMatchMedia(compact);
    render(<TopologyPanel />);

    const activeButton = screen.getByRole('button', { name: active });
    const inactiveButton = screen.getByRole('button', { name: inactive });
    expect(activeButton.tagName).toBe('BUTTON');
    expect(activeButton.getAttribute('aria-pressed')).toBe('true');
    expect(inactiveButton.getAttribute('aria-pressed')).toBe('false');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Service topology' })).toBeDefined();
  });

  test('uses Service topology as the exact page identity', () => {
    render(<TopologyPanel />);

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('Service topology');
  });

  test('a later resize does not overwrite an explicit representation choice', () => {
    const viewport = installMatchMedia(false);
    render(<TopologyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');

    act(() => viewport.resize(true));

    expect(screen.getByRole('button', { name: 'Map' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('false');
  });

  test('Map and List share case-insensitive search while detail follows the latest node by name', () => {
    installMatchMedia(true);
    const view = render(<TopologyPanel />);
    fireEvent.click(screen.getByRole('button', { name: /checkout/i }));
    expect(screen.getByRole('complementary', { name: 'Service details: checkout' })).toBeDefined();

    h.graph = {
      ...graph,
      nodes: graph.nodes.map((node) =>
        node.name === 'checkout' ? { ...node, team: 'latest-platform-team' } : node,
      ),
    };
    view.rerender(<TopologyPanel />);
    expect(
      within(screen.getByRole('complementary')).getByText('latest-platform-team'),
    ).toBeDefined();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search services' }), {
      target: { value: 'PAY' },
    });
    expect(
      within(screen.getByRole('list', { name: 'Topology services' })).getByRole('button', {
        name: /payments/i,
      }),
    ).toBeDefined();
    expect(
      within(screen.getByRole('list', { name: 'Topology services' })).queryByRole('button', {
        name: /checkout/i,
      }),
    ).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Service details: checkout' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    const svg = screen.getByLabelText('Service dependency graph');
    expect(within(svg).getByText('payments')).toBeDefined();
    expect(within(svg).queryByText('checkout')).toBeNull();
  });

  test('Close and Escape restore focus to the service selection button', () => {
    installMatchMedia(true);
    render(<TopologyPanel />);
    const checkout = screen.getByRole('button', { name: /checkout/i });
    checkout.focus();
    fireEvent.click(checkout);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /checkout/i }));

    fireEvent.click(screen.getByRole('button', { name: /checkout/i }));
    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /checkout/i }));
  });

  test('Escape on the still-focused service trigger closes detail and restores that trigger', () => {
    installMatchMedia(true);
    render(<TopologyPanel />);
    const checkout = screen.getByRole('button', { name: /checkout/i });
    checkout.focus();
    fireEvent.click(checkout);
    expect(screen.getByRole('complementary', { name: 'Service details: checkout' })).toBeDefined();

    fireEvent.keyDown(checkout, { key: 'Escape' });

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(document.activeElement).toBe(checkout);
  });
});
