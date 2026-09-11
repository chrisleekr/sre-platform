// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TopologyGraph } from '../../lib/topology';
import { installDialogMethods } from '../../test/dialog';

const h = vi.hoisted(() => ({
  saveService: vi.fn(async () => {}),
  saveDependency: vi.fn(async () => {}),
}));

vi.mock('../../lib/useTopology', () => ({
  saveTopologyService: h.saveService,
  saveTopologyDependency: h.saveDependency,
}));

import { TopologyCatalogManager } from '../TopologyCatalogManager';

const graph: TopologyGraph = {
  nodes: [
    {
      name: 'checkout',
      team: 'commerce',
      criticality: 'tier1',
      sources: ['catalog'],
      lastDeployAt: null,
      recentDeploys: [],
    },
    {
      name: 'payments',
      team: 'payments',
      criticality: 'tier1',
      sources: ['catalog'],
      lastDeployAt: null,
      recentDeploys: [],
    },
  ],
  edges: [],
};

let dialogMethods: ReturnType<typeof installDialogMethods>;

beforeEach(() => {
  dialogMethods = installDialogMethods();
  h.saveService.mockReset();
  h.saveService.mockResolvedValue(undefined);
  h.saveDependency.mockReset();
  h.saveDependency.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  dialogMethods.restore();
});

function renderManager() {
  const onSaved = vi.fn();
  render(
    <TopologyCatalogManager
      graph={graph}
      apiBaseUrl="http://api"
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'jwt' })}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit catalog' }));
  return onSaved;
}

describe('TopologyCatalogManager', () => {
  test('loads normalized ownership and clears it when the service no longer matches', () => {
    renderManager();

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: ' checkout ' } });
    expect((screen.getByLabelText('Owning team') as HTMLInputElement).value).toBe('commerce');
    expect((screen.getByLabelText('Criticality') as HTMLSelectElement).value).toBe('tier1');

    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'new-service' } });
    expect((screen.getByLabelText('Owning team') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Criticality') as HTMLSelectElement).value).toBe('');
  });

  test('saves trimmed service ownership and refreshes the graph', async () => {
    const onSaved = renderManager();
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: ' checkout ' } });
    fireEvent.change(screen.getByLabelText('Owning team'), { target: { value: ' commerce ' } });
    fireEvent.change(screen.getByLabelText('Criticality'), { target: { value: 'tier1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save service' }));

    await waitFor(() =>
      expect(h.saveService).toHaveBeenCalledWith('http://api', expect.any(Function), {
        name: 'checkout',
        team: 'commerce',
        criticality: 'tier1',
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(screen.getByRole('status').textContent).toMatch(/checkout is registered/i);
  });

  test('saves an explicit relationship and prevents a self-edge', async () => {
    const onSaved = renderManager();
    fireEvent.change(screen.getByLabelText('Upstream'), { target: { value: 'checkout' } });
    fireEvent.change(screen.getByLabelText('Downstream'), { target: { value: 'checkout' } });
    expect(
      (screen.getByRole('button', { name: 'Save relationship' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByText(/choose two different services/i)).toBeDefined();

    fireEvent.change(screen.getByLabelText('Downstream'), { target: { value: 'payments' } });
    fireEvent.change(screen.getByLabelText('Call type'), { target: { value: 'async' } });
    fireEvent.click(screen.getByLabelText(/circuit breaker/i));
    fireEvent.click(screen.getByRole('button', { name: 'Save relationship' }));

    await waitFor(() =>
      expect(h.saveDependency).toHaveBeenCalledWith('http://api', expect.any(Function), {
        upstream: 'checkout',
        downstream: 'payments',
        syncType: 'async',
        circuitBreaker: true,
      }),
    );
    expect(onSaved).toHaveBeenCalledOnce();
  });

  test('keeps the form available and reports a rejected save', async () => {
    h.saveService.mockRejectedValueOnce(new Error('service update rejected'));
    renderManager();
    fireEvent.change(screen.getByLabelText('Service'), { target: { value: 'checkout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save service' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/service update rejected/i);
    expect((screen.getByLabelText('Service') as HTMLInputElement).value).toBe('checkout');
  });
});
