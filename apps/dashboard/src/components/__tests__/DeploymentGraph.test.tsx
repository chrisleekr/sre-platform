// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { DeploymentGraph, serviceStatusColour } from '../DeploymentGraph';
import type { GraphNode, TopologyGraph, BlastRadius } from '../../lib/topology';

const RED = 'var(--sre-critical-solid)';
const ORANGE = 'var(--sre-warning-solid)';
const AMBER = 'var(--sre-warning)';
const GREEN = 'var(--sre-success-solid)';
const NEUTRAL = 'var(--sre-ink-faint)';

function mouseEvent(
  view: Window & typeof globalThis,
  type: string,
  init: MouseEventInit,
): MouseEvent {
  const event = new view.MouseEvent(type, init);
  Object.defineProperty(event, 'view', { value: view });
  return event;
}

describe('serviceStatusColour', () => {
  test.each([
    ['incident', RED],
    ['attention', ORANGE],
    ['stale', AMBER],
    ['healthy', GREEN],
    ['unknown', NEUTRAL],
    [undefined, NEUTRAL],
  ] as const)('maps %s to its operational colour', (status, colour) => {
    expect(serviceStatusColour(status)).toBe(colour);
  });
});

function node(over: Partial<GraphNode> & { name: string }): GraphNode {
  return {
    team: null,
    criticality: null,
    lastDeployAt: null,
    recentDeploys: [],
    ...over,
  };
}

const graph: TopologyGraph = {
  nodes: [
    node({ name: 'checkout', status: 'incident' }),
    node({ name: 'orders', status: 'unknown' }),
  ],
  edges: [{ upstream: 'checkout', downstream: 'orders', syncType: 'async', circuitBreaker: false }],
};

describe('DeploymentGraph', () => {
  test('renders a node per service with its label', () => {
    render(<DeploymentGraph graph={graph} />);
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.getByText('orders')).toBeDefined();
  });

  test('colours a node by operational status', () => {
    const { container } = render(<DeploymentGraph graph={graph} />);
    const checkout = container.querySelector('circle[data-node="checkout"]');
    const orders = container.querySelector('circle[data-node="orders"]');
    expect(checkout?.getAttribute('fill')).toBe(RED);
    expect(orders?.getAttribute('fill')).toBe(NEUTRAL);
  });

  test('renders an edge between dependent services (dashed for async)', () => {
    const { container } = render(<DeploymentGraph graph={graph} />);
    const edge = container.querySelector('line[data-edge="checkout->orders"]');
    expect(edge).not.toBeNull();
    expect(edge?.getAttribute('data-sync')).toBe('async');
    expect(edge?.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  test('applies the blast-radius highlight rings', () => {
    const blast: BlastRadius = {
      service: 'checkout',
      mapped: true,
      dependents: {
        direct: [{ name: 'orders', criticality: null, team: null, hops: 1 }],
        indirect: [],
        insulated: [],
      },
      suspects: [],
      truncated: false,
    };
    const { container } = render(<DeploymentGraph graph={graph} blastRadius={blast} />);
    expect(container.querySelector('[data-highlight="affected"]')).not.toBeNull();
    expect(container.querySelector('[data-highlight="direct"]')).not.toBeNull();
  });

  test('calls onSelect with the clicked node', () => {
    const onSelect = vi.fn();
    const { container } = render(<DeploymentGraph graph={graph} onSelect={onSelect} />);
    const checkout = container.querySelector('circle[data-node="checkout"]');
    expect(checkout).not.toBeNull();
    if (checkout) fireEvent.click(checkout);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]?.name).toBe('checkout');
  });

  test('re-colours a node when health changes without changing the node set', () => {
    const before: TopologyGraph = {
      nodes: [node({ name: 'checkout', status: 'unknown' })],
      edges: [],
    };
    const { container, rerender } = render(<DeploymentGraph graph={before} />);
    expect(container.querySelector('circle[data-node="checkout"]')?.getAttribute('fill')).toBe(
      NEUTRAL,
    );
    const after: TopologyGraph = {
      nodes: [node({ name: 'checkout', status: 'healthy' })],
      edges: [],
    };
    rerender(<DeploymentGraph graph={after} />);
    expect(container.querySelector('circle[data-node="checkout"]')?.getAttribute('fill')).toBe(
      GREEN,
    );
  });

  test('onSelect receives the latest node data after a poll update', () => {
    const before: TopologyGraph = {
      nodes: [node({ name: 'checkout' })],
      edges: [],
    };
    const onSelect = vi.fn();
    const { container, rerender } = render(<DeploymentGraph graph={before} onSelect={onSelect} />);
    const after: TopologyGraph = {
      nodes: [
        node({
          name: 'checkout',
          recentDeploys: [
            {
              sha: 's1',
              ref: 'main',
              status: 'success',
              deployedAt: new Date().toISOString(),
            },
          ],
        }),
      ],
      edges: [],
    };
    rerender(<DeploymentGraph graph={after} onSelect={onSelect} />);
    const checkout = container.querySelector('circle[data-node="checkout"]');
    if (checkout) fireEvent.click(checkout);
    expect(onSelect.mock.calls[0]?.[0]?.recentDeploys).toHaveLength(1);
  });

  test('exposes each SVG service as a pressed keyboard button with visible focus styling', () => {
    const onSelect = vi.fn();
    render(<DeploymentGraph graph={graph} selected="checkout" onSelect={onSelect} />);

    const checkout = screen.getByRole('button', { name: /checkout/i });
    expect(checkout.getAttribute('tabindex')).toBe('0');
    expect(checkout.getAttribute('aria-pressed')).toBe('true');
    expect(checkout.getAttribute('class')).toMatch(/focus/);

    checkout.focus();
    expect(document.activeElement).toBe(checkout);
    fireEvent.keyDown(checkout, { key: 'Enter' });
    fireEvent.keyDown(checkout, { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect.mock.calls.every((call) => call[0].name === 'checkout')).toBe(true);
  });

  test('renders a complete legend for every actual node, ring, edge, and direction encoding', () => {
    render(<DeploymentGraph graph={graph} />);

    const legend = screen.getByLabelText('Topology legend');
    for (const label of [
      'Active incident',
      'Runtime attention',
      'Stale telemetry',
      'Healthy runtime',
      'No live telemetry',
      'Selected service',
      'Affected service',
      'Direct dependent',
      'Indirect dependent',
      'Synchronous dependency',
      'Asynchronous dependency',
      'Circuit breaker',
      'Arrow points to dependency',
    ]) {
      expect(within(legend).getByText(label)).toBeDefined();
    }
    expect(within(legend).queryByText(/insulated/i)).toBeNull();

    expect(legend.querySelector('[data-legend="status-incident"]')?.getAttribute('fill')).toBe(RED);
    expect(legend.querySelector('[data-legend="status-attention"]')?.getAttribute('fill')).toBe(
      ORANGE,
    );
    expect(legend.querySelector('[data-legend="status-stale"]')?.getAttribute('fill')).toBe(AMBER);
    expect(legend.querySelector('[data-legend="status-healthy"]')?.getAttribute('fill')).toBe(
      GREEN,
    );
    expect(legend.querySelector('[data-legend="status-unknown"]')?.getAttribute('fill')).toBe(
      NEUTRAL,
    );
    expect(legend.querySelector('[data-legend="selected"]')?.getAttribute('stroke')).toBe(
      'var(--sre-ink)',
    );
    expect(legend.querySelector('[data-legend="affected"]')?.getAttribute('stroke')).toBe(RED);
    expect(legend.querySelector('[data-legend="direct"]')?.getAttribute('stroke')).toBe(
      'var(--sre-warning-solid)',
    );
    expect(legend.querySelector('[data-legend="indirect"]')?.getAttribute('stroke')).toBe(AMBER);
    expect(
      legend.querySelector('[data-legend="sync"]')?.getAttribute('stroke-dasharray'),
    ).toBeNull();
    expect(
      legend.querySelector('[data-legend="async"]')?.getAttribute('stroke-dasharray'),
    ).toBeTruthy();
    expect(legend.querySelector('[data-legend="circuit"]')?.getAttribute('stroke')).toBe(
      'var(--sre-info)',
    );
    expect(legend.querySelector('[data-legend="arrow"]')?.getAttribute('marker-end')).toBeTruthy();
  });

  test('updates edge styling when a poll changes metadata without changing endpoints', () => {
    const before: TopologyGraph = {
      nodes: [node({ name: 'checkout' }), node({ name: 'orders' })],
      edges: [
        {
          upstream: 'checkout',
          downstream: 'orders',
          syncType: 'sync',
          circuitBreaker: false,
        },
      ],
    };
    const { container, rerender } = render(<DeploymentGraph graph={before} />);
    const edge = () => container.querySelector('line[data-edge="checkout->orders"]');
    expect(edge()?.getAttribute('stroke-dasharray')).toBeNull();
    expect(edge()?.getAttribute('stroke')).toBe('var(--sre-line-strong)');

    rerender(
      <DeploymentGraph
        graph={{
          ...before,
          edges: [
            {
              upstream: 'checkout',
              downstream: 'orders',
              syncType: 'async',
              circuitBreaker: true,
            },
          ],
        }}
      />,
    );

    expect(edge()?.getAttribute('stroke-dasharray')).toBeTruthy();
    expect(edge()?.getAttribute('stroke')).toBe('var(--sre-info)');
  });

  test('drags the current rendered node after same-endpoint edge metadata replaces the simulation', async () => {
    const before: TopologyGraph = {
      nodes: [node({ name: 'checkout' }), node({ name: 'orders' })],
      edges: [
        {
          upstream: 'checkout',
          downstream: 'orders',
          syncType: 'sync',
          circuitBreaker: false,
        },
      ],
    };
    const { container, rerender, unmount } = render(<DeploymentGraph graph={before} />);
    rerender(
      <DeploymentGraph
        graph={{
          ...before,
          edges: [
            {
              upstream: 'checkout',
              downstream: 'orders',
              syncType: 'async',
              circuitBreaker: true,
            },
          ],
        }}
      />,
    );

    const checkout = container.querySelector<SVGCircleElement>('circle[data-node="checkout"]');
    expect(checkout).not.toBeNull();
    if (!checkout) return;
    const startX = Number(checkout.getAttribute('cx'));
    const startY = Number(checkout.getAttribute('cy'));
    const view = checkout.ownerDocument.defaultView;
    expect(view).not.toBeNull();
    if (!view) return;
    fireEvent(
      checkout,
      mouseEvent(view, 'mousedown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: startX,
        clientY: startY,
      }),
    );
    fireEvent(
      view,
      mouseEvent(view, 'mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: startX + 80,
        clientY: startY + 40,
      }),
    );

    await waitFor(() => expect(Number(checkout.getAttribute('cx'))).not.toBe(startX));
    fireEvent(
      view,
      mouseEvent(view, 'mouseup', {
        bubbles: true,
        button: 0,
        clientX: startX + 80,
        clientY: startY + 40,
      }),
    );
    unmount();
    // Drain d3-force's queued post-drag frame before the next graph creates its own timer.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  test('fits the simulated services and resets the D3 zoom transform', () => {
    const { container } = render(<DeploymentGraph graph={graph} />);
    const scene = container.querySelector('svg > g');
    expect(scene?.getAttribute('transform')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Fit services' }));
    const fitted = scene?.getAttribute('transform');
    expect(fitted).toMatch(/translate\(.+\) scale\(.+\)/);

    fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
    expect(scene?.getAttribute('transform')).not.toBe(fitted);
    expect(scene?.getAttribute('transform') ?? '').toMatch(/^$|translate\(0,0\) scale\(1\)/);
  });

  test('wheel zoom changes the root scene transform through the bound SVG surface', () => {
    const { container, unmount } = render(<DeploymentGraph graph={graph} />);
    const svg = screen.getByLabelText('Service dependency graph');
    const scene = container.querySelector('svg > g');
    expect(scene?.getAttribute('transform')).toBeNull();

    fireEvent.wheel(svg, { deltaY: -120, clientX: 410, clientY: 280 });

    expect(scene?.getAttribute('transform')).toMatch(/translate\(.+\) scale\(.+\)/);
    unmount();
  });

  test('background mouse pan changes the root scene transform through the bound SVG surface', () => {
    const { container } = render(<DeploymentGraph graph={graph} />);
    const svg = screen.getByLabelText('Service dependency graph');
    const scene = container.querySelector('svg > g');
    const view = svg.ownerDocument.defaultView;
    expect(view).not.toBeNull();
    if (!view) return;

    fireEvent(
      svg,
      mouseEvent(view, 'mousedown', {
        bubbles: true,
        button: 0,
        buttons: 1,
        clientX: 100,
        clientY: 100,
      }),
    );
    fireEvent(
      view,
      mouseEvent(view, 'mousemove', {
        bubbles: true,
        buttons: 1,
        clientX: 160,
        clientY: 140,
      }),
    );

    expect(scene?.getAttribute('transform')).toMatch(/translate\(.+\) scale\(.+\)/);
    fireEvent(
      view,
      mouseEvent(view, 'mouseup', {
        bubbles: true,
        button: 0,
        clientX: 160,
        clientY: 140,
      }),
    );
  });
});
