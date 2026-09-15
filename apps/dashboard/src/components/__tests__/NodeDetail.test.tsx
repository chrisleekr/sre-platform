// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeploymentGraph } from '../DeploymentGraph';
import { NodeDetail } from '../NodeDetail';
import type { GraphNode, TopologyGraph } from '../../lib/topology';
import type { Incident } from '../../lib/types';

const checkout: GraphNode = {
  name: 'checkout',
  team: 'payments',
  criticality: 'tier1',
  lastDeployAt: new Date().toISOString(),
  recentDeploys: [
    {
      sha: 'abc1234',
      ref: 'main',
      status: 'success',
      deployedAt: new Date().toISOString(),
    },
  ],
};
const graph: TopologyGraph = { nodes: [checkout], edges: [] };

const incidents: Incident[] = [
  {
    id: 'inc1',
    service: 'checkout',
    severity: 'sev1',
    status: 'mitigated',
    investigationStatus: 'gathering',
    lifecycleVersion: 1,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date().toISOString(),
  },
  {
    id: 'inc2',
    service: 'checkout',
    severity: 'sev3',
    status: 'resolved', // not active -> excluded from the drawer alerts
    investigationStatus: 'assessed',
    lifecycleVersion: 2,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date().toISOString(),
  },
];

/** Minimal harness mirroring TopologyPanel's graph -> drawer wiring for the click flow. */
function Harness() {
  const [selected, setSelected] = useState<GraphNode | null>(null);
  return (
    <div>
      <DeploymentGraph graph={graph} onSelect={setSelected} />
      {selected && (
        <NodeDetail node={selected} incidents={incidents} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

describe('NodeDetail via node click', () => {
  test('shows runtime rollup, discovery sources, and both relationship directions', () => {
    const payments: GraphNode = {
      ...checkout,
      name: 'payments',
      sources: ['catalog'],
      runtime: undefined,
    };
    const storefront: GraphNode = { ...checkout, name: 'storefront', runtime: undefined };
    const operationalCheckout: GraphNode = {
      ...checkout,
      sources: ['catalog', 'kubernetes', 'incident'],
      status: 'incident',
      runtime: {
        namespace: 'checkout',
        pods: 3,
        healthy: 2,
        attention: 1,
        stale: 0,
        errors: 0,
        restarts: 7,
        oomKilled: 1,
        observedAt: new Date().toISOString(),
      },
    };
    render(
      <NodeDetail
        node={operationalCheckout}
        incidents={incidents}
        graph={{
          nodes: [operationalCheckout, payments, storefront],
          edges: [
            {
              upstream: 'storefront',
              downstream: 'checkout',
              syncType: 'sync',
              circuitBreaker: false,
            },
            {
              upstream: 'checkout',
              downstream: 'payments',
              syncType: 'async',
              circuitBreaker: true,
            },
          ],
        }}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText('catalog · kubernetes · incident')).toBeDefined();
    expect(screen.getByText(/2\/3 pods healthy · 1 attention/)).toBeDefined();
    expect(screen.getByText(/7 restarts · 1 OOM-killed pods/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'storefront' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'payments' })).toBeDefined();
    expect(screen.getByText(/\(async, breaker\)/)).toBeDefined();
  });

  test('clicking a node opens a drawer with its recent deploys and active alerts', () => {
    const { container } = render(<Harness />);
    // No drawer until a node is clicked.
    expect(screen.queryByText('abc1234')).toBeNull();

    const circle = container.querySelector('circle[data-node="checkout"]');
    expect(circle).not.toBeNull();
    if (circle) fireEvent.click(circle);

    // Recent deploy sha.
    expect(screen.getByText('abc1234')).toBeDefined();
    // Active lifecycle incident shown; the resolved incident is filtered out.
    expect(screen.getByText('mitigated')).toBeDefined();
    expect(screen.queryByText('resolved')).toBeNull();
  });

  test('renders empty states for a service with no deploys or alerts', () => {
    render(
      <NodeDetail node={{ ...checkout, recentDeploys: [] }} incidents={[]} onClose={() => {}} />,
    );
    expect(screen.getByText('No deploys.')).toBeDefined();
    expect(screen.getByText('No active alerts.')).toBeDefined();
  });

  test('renders a deploy with its sha and a relative time', () => {
    render(
      <NodeDetail
        node={{
          ...checkout,
          recentDeploys: [
            {
              sha: 'def5678',
              ref: 'main',
              status: 'success',
              deployedAt: new Date().toISOString(),
            },
          ],
        }}
        incidents={[]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('def5678')).toBeDefined();
    expect(screen.getByText('just now')).toBeDefined();
  });

  test('is a named non-modal detail with a visible native Close control', () => {
    const onClose = vi.fn();
    render(<NodeDetail node={checkout} incidents={incidents} onClose={onClose} />);

    expect(screen.getByRole('complementary', { name: 'Service details: checkout' })).toBeDefined();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('closes on Escape from anywhere in the detail', () => {
    const onClose = vi.fn();
    render(<NodeDetail node={checkout} incidents={incidents} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('uses a full-width compact layout and wraps long service identity', () => {
    const name = 'checkout-edge-router-with-a-long-uninterrupted-service-identity';
    render(<NodeDetail node={{ ...checkout, name }} incidents={[]} onClose={() => {}} />);

    const detail = screen.getByRole('complementary', { name: `Service details: ${name}` });
    expect(detail.className).toMatch(/w-full/);
    expect(detail.className).toMatch(/lg:w-|sm:w-|md:w-/);
    expect(screen.getByRole('heading', { name }).className).toMatch(/break-words|break-all/);
  });
});

test('relationship keys distinguish endpoint and environment tuples containing slashes', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    render(
      <NodeDetail
        node={checkout}
        incidents={[]}
        onClose={() => {}}
        graph={{
          ...graph,
          edges: [
            {
              upstream: 'checkout',
              downstream: 'a/b',
              environment: 'c',
              syncType: 'sync',
              circuitBreaker: false,
            },
            {
              upstream: 'checkout',
              downstream: 'a',
              environment: 'b/c',
              syncType: 'sync',
              circuitBreaker: false,
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('a/b')).toBeTruthy();
    expect(screen.getByText('a')).toBeTruthy();
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  } finally {
    error.mockRestore();
  }
});
