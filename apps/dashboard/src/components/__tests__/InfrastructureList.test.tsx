// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { InfrastructureList } from '../InfrastructureList';
import type { InfraSnapshot } from '../../lib/types';
import { formatAbsoluteTime } from '../../lib/time';

const NOW = '2026-08-18T01:00:00.000Z';

function snapshot(overrides: Partial<InfraSnapshot> = {}): InfraSnapshot {
  return {
    dataSourceId: '00000000-0000-4000-8000-000000000001',
    dataSourceName: 'Primary Kubernetes',
    source: 'kubernetes',
    entityId: 'checkout/api-abc',
    metrics: { ready: 1, restartCount: 0, oomKilled: 0 },
    observedAt: '2026-08-18T00:59:30.000Z',
    kind: 'pod',
    namespace: 'checkout',
    phase: 'Running',
    containers: [{ name: 'api', ready: true, restartCount: 0 }],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('InfrastructureList', () => {
  test('shows an empty state that explains where infrastructure data comes from', () => {
    render(<InfrastructureList snapshots={[]} />);

    expect(screen.getByText('No infrastructure data yet.')).toBeDefined();
    expect(
      screen.getByText(/snapshots from configured connectors will appear here/i),
    ).toBeDefined();
  });

  test('shows mutually exclusive healthy, attention, stale, and error counts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({ entityId: 'checkout/healthy' }),
          snapshot({
            entityId: 'checkout/oom',
            metrics: { ready: 1, restartCount: 3, oomKilled: 1 },
          }),
          snapshot({
            entityId: 'checkout/stale',
            observedAt: '2026-08-18T00:58:59.999Z',
          }),
          snapshot({
            entityId: 'cluster/nodes',
            kind: 'node',
            namespace: undefined,
            error: 'denied',
          }),
        ]}
      />,
    );

    const overview = screen.getByLabelText('Infrastructure overview');
    expect(overview.textContent).toMatch(/Healthy\s*1/);
    expect(overview.textContent).toMatch(/Attention\s*1/);
    expect(overview.textContent).toMatch(/Stale\s*1/);
    expect(overview.textContent).toMatch(/Errors\s*1/);
    expect(screen.getByText('4 resources across 1 namespace')).toBeDefined();
  });

  test('treats completed jobs as healthy even when their containers are no longer ready', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({
            entityId: 'jobs/backup-42',
            namespace: 'jobs',
            phase: 'Succeeded',
            metrics: { ready: 0, restartCount: 0, oomKilled: 0 },
            containers: [
              {
                name: 'backup',
                ready: false,
                restartCount: 0,
                terminatedReason: 'Completed',
              },
            ],
          }),
        ]}
      />,
    );

    const row = screen.getByText('backup-42').closest('tr')!;
    expect(row.textContent).toMatch(/healthy/i);
    expect(row.textContent).toMatch(/Succeeded/);
    expect(row.textContent).not.toMatch(/Not ready/);
    expect(within(row).queryByLabelText('Container issues')).toBeNull();
  });

  test('shows a prior OOM termination as history without marking a recovered pod unhealthy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({
            entityId: 'argocd/argocd-server',
            namespace: 'argocd',
            metrics: { ready: 1, restartCount: 1, oomKilled: 0 },
            containers: [
              {
                name: 'server',
                ready: true,
                restartCount: 1,
                lastTerminatedReason: 'OOMKilled',
                lastTerminatedAt: '2026-08-17T05:43:23.000Z',
              },
            ],
          }),
          snapshot({ entityId: 'checkout/healthy-api' }),
        ]}
      />,
    );

    const overview = screen.getByLabelText('Infrastructure overview');
    expect(overview.textContent).toMatch(/Healthy\s*2/);
    expect(overview.textContent).toMatch(/Attention\s*0/);
    const row = screen.getByText('argocd-server').closest('tr')!;
    expect(row.textContent).toContain('Previous termination');
    expect(row.textContent).toContain('server: OOMKilled');
    expect(row.textContent).toContain('19h ago');
    expect(within(row).queryByLabelText('Container issues')).toBeNull();

    fireEvent.change(screen.getByLabelText('Search current snapshot'), {
      target: { value: 'OOMKilled' },
    });
    expect(screen.getByText('argocd-server')).toBeDefined();
    expect(screen.queryByText('healthy-api')).toBeNull();
  });

  test('uses error, stale, attention, healthy precedence and shows issues first', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({ entityId: 'checkout/z-healthy' }),
          snapshot({ entityId: 'checkout/c-attention', metrics: { ready: 0 } }),
          snapshot({
            entityId: 'checkout/b-stale',
            observedAt: '2026-08-18T00:58:00.000Z',
            metrics: { ready: 0 },
          }),
          snapshot({
            entityId: 'checkout/a-error',
            observedAt: '2026-08-18T00:58:00.000Z',
            metrics: { ready: 0 },
            error: 'collector failed',
          }),
        ]}
      />,
    );

    const rows = screen.getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('a-error'),
      expect.stringContaining('b-stale'),
      expect.stringContaining('c-attention'),
      expect.stringContaining('z-healthy'),
    ]);
  });

  test('searches operational detail and filters by status, kind, and namespace', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({ entityId: 'checkout/healthy-api' }),
          snapshot({
            entityId: 'payments/worker',
            namespace: 'payments',
            metrics: { ready: 0, restartCount: 8, oomKilled: 0 },
            containers: [
              {
                name: 'queue-worker',
                ready: false,
                restartCount: 8,
                waitingReason: 'CrashLoopBackOff',
              },
            ],
          }),
          snapshot({
            entityId: 'worker-01',
            namespace: undefined,
            kind: 'node',
            metrics: { ready: 0, pressures: 1 },
            pressures: ['MemoryPressure'],
          }),
        ]}
      />,
    );

    fireEvent.change(screen.getByLabelText('Search current snapshot'), {
      target: { value: 'CrashLoopBackOff' },
    });
    expect(screen.getByText('worker')).toBeDefined();
    expect(screen.queryByText('healthy-api')).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Showing 1 of 3/);

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'issues' } });
    expect(screen.queryByText('healthy-api')).toBeNull();
    expect(screen.getByText('worker')).toBeDefined();
    expect(screen.getByText('worker-01')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'node' } });
    expect(screen.queryByText('worker')).toBeNull();
    expect(screen.getByText('worker-01')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'payments' } });
    expect(screen.getByText('worker')).toBeDefined();
    expect(screen.queryByText('healthy-api')).toBeNull();
    expect(screen.queryByText('worker-01')).toBeNull();
  });

  test('shows pod and node signals, including actionable container reasons and pressure', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({
            entityId: 'payments/worker',
            namespace: 'payments',
            metrics: { ready: 0, restartCount: 8, oomKilled: 1 },
            containers: [
              {
                name: 'queue-worker',
                ready: false,
                restartCount: 8,
                waitingReason: 'CrashLoopBackOff',
                terminatedReason: 'OOMKilled',
              },
            ],
          }),
          snapshot({
            entityId: 'worker-01',
            namespace: undefined,
            kind: 'node',
            metrics: { ready: 0, pressures: 1 },
            pressures: ['MemoryPressure'],
          }),
        ]}
      />,
    );

    const podRow = screen.getByText('worker').closest('tr')!;
    expect(podRow.textContent).toMatch(/Running.*Not ready.*8 restarts.*OOM killed/);
    expect(within(podRow).getByText('queue-worker: CrashLoopBackOff')).toBeDefined();

    const nodeRow = screen.getByText('worker-01').closest('tr')!;
    expect(nodeRow.textContent).toMatch(/Not ready.*Pressure: MemoryPressure/);
    expect(nodeRow.textContent).toContain('Cluster-scoped');
  });

  test('keeps a generic connector metric fallback and full connector error', () => {
    render(
      <InfrastructureList
        snapshots={[
          snapshot({
            source: 'aws',
            entityId: 'orders-db',
            kind: undefined,
            namespace: undefined,
            metrics: { cpu: 0.42, memoryBytes: 2048 },
          }),
          snapshot({
            source: 'aws',
            entityId: 'collector',
            kind: undefined,
            namespace: undefined,
            metrics: {},
            error: 'Prometheus scrape failed: upstream returned 503',
          }),
        ]}
      />,
    );

    const metricsRow = screen.getByText('orders-db').closest('tr')!;
    expect(metricsRow.textContent).toMatch(/cpu=0.42, memoryBytes=2048/);
    expect(
      within(screen.getByText('collector').closest('tr')!).getByText(
        'Prometheus scrape failed: upstream returned 503',
      ),
    ).toBeDefined();
  });

  test('treats exactly 60 seconds as fresh and an invalid timestamp as stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    render(
      <InfrastructureList
        snapshots={[
          snapshot({ entityId: 'checkout/at-boundary', observedAt: '2026-08-18T00:59:00.000Z' }),
          snapshot({ entityId: 'checkout/invalid-time', observedAt: 'invalid' }),
        ]}
      />,
    );

    expect(screen.getByText('at-boundary').closest('tr')?.textContent).toMatch(/healthy/i);
    expect(screen.getByText('invalid-time').closest('tr')?.textContent).toMatch(/stale/i);
  });

  test('renders relative and exact observation time semantically', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T01:05:00.000Z'));
    const observedAt = '2026-08-18T01:00:00.000Z';
    const { container } = render(<InfrastructureList snapshots={[snapshot({ observedAt })]} />);

    const row = screen.getByText('api-abc').closest('tr')!;
    const time = row.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(observedAt);
    expect(time?.getAttribute('title')).toBe(formatAbsoluteTime(observedAt));
    expect(time?.textContent).toBe('5m ago');
    expect(within(row).getByText(formatAbsoluteTime(observedAt))).toBeDefined();
    expect(container.querySelectorAll('time')).toHaveLength(2);
  });

  test('keeps labelled resource cards until the large-screen table breakpoint', () => {
    const longEntity = 'checkout/edge-router-with-a-long-uninterrupted-identity';
    const { container } = render(
      <InfrastructureList snapshots={[snapshot({ entityId: longEntity })]} />,
    );

    const row = screen.getByText('edge-router-with-a-long-uninterrupted-identity').closest('tr')!;
    for (const label of ['Health', 'Resource', 'Namespace', 'Signals', 'Observed']) {
      expect(row.querySelector(`[data-label="${label}"]`)).not.toBeNull();
    }
    const table = row.closest('table')!;
    const head = table.querySelector('thead')!;
    const body = table.querySelector('tbody')!;

    expect(table.className).toContain('lg:table');
    expect(table.className).not.toMatch(/(?:sm|md):table/);
    expect(head.className).toContain('lg:table-header-group');
    expect(body.className).toContain('lg:table-row-group');
    expect(row.className).toMatch(/grid|block/);
    expect(row.className).toMatch(/lg:mb-0.*lg:table-row.*lg:border-0.*lg:p-0/);
    expect(row.className).not.toMatch(/(?:sm|md):(?:mb-0|table-row|border-0|p-0)/);
    for (const cell of within(row).getAllByRole('cell')) {
      expect(cell.className).toContain('lg:table-cell');
      expect(cell.className).toContain('lg:before:hidden');
      expect(cell.className).not.toMatch(/(?:sm|md):(?:table-cell|before:hidden)/);
    }
    expect(row.querySelector('[data-label="Resource"]')?.className).toMatch(
      /break-words|break-all/,
    );
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });
});
