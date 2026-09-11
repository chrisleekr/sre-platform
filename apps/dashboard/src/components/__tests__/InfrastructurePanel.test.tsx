// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { InfraSnapshot } from '../../lib/types';

const h = vi.hoisted(() => ({
  snapshots: [] as InfraSnapshot[],
  loading: false,
  error: false,
  errorStatus: null as number | null,
  backgroundError: false,
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../lib/useInfrastructure', () => ({
  useInfrastructure: () => ({
    snapshots: h.snapshots,
    loading: h.loading,
    error: h.error,
    errorStatus: h.errorStatus,
    backgroundError: h.backgroundError,
  }),
}));

import { InfrastructurePanel } from '../InfrastructurePanel';

afterEach(() => {
  cleanup();
  h.snapshots = [];
  h.loading = false;
  h.error = false;
  h.errorStatus = null;
  h.backgroundError = false;
});

describe('InfrastructurePanel page states', () => {
  test('uses one page heading and a reserved, polite first-load status (C1, C7)', () => {
    h.loading = true;
    const { container } = render(<InfrastructurePanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Infrastructure' })).toBeDefined();
    expect(container.querySelector('[data-page-state="loading"]')?.className).toMatch(/min-h-/);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading infrastructure/i);
  });

  test('renders a specific retrieval error on an initial failure (C3, C6)', () => {
    h.error = true;
    render(<InfrastructurePanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load infrastructure/i);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  test('explains a tenant-membership 403 instead of reporting a generic retrieval failure', () => {
    h.error = true;
    h.errorStatus = 403;
    render(<InfrastructurePanel />);

    expect(screen.getByRole('alert').textContent).toMatch(/tenant access/i);
    expect(screen.getByRole('alert').textContent).toMatch(/assigned to exactly one tenant/i);
    expect(screen.queryByText(/snapshots could not be retrieved/i)).toBeNull();
  });

  test('keeps last-good rows visible and reports a failed background refresh', () => {
    h.snapshots = [
      {
        dataSourceId: '00000000-0000-4000-8000-000000000001',
        dataSourceName: 'Primary Kubernetes',
        source: 'kubernetes',
        entityId: 'default/api-1',
        metrics: { ready: 1 },
        observedAt: new Date().toISOString(),
      },
    ];
    h.error = true;
    h.backgroundError = true;
    render(<InfrastructurePanel />);

    expect(screen.getByRole('alert').textContent).toMatch(/live refresh failed/i);
    expect(screen.getByText('default/api-1')).toBeDefined();
  });
});
