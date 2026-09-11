// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ChangeEvent } from '../../lib/types';

let lastOptions: { cursor?: string; filters?: Record<string, string | undefined> } = {};
const change: ChangeEvent = {
  id: 'change-1',
  provider: 'github',
  dataSourceId: '00000000-0000-4000-8000-000000000001',
  dataSourceName: 'Primary GitHub',
  category: 'ci',
  eventType: 'workflow_run',
  repository: 'acme/checkout',
  actor: 'ci-bot',
  ref: 'refs/heads/main',
  sha: 'abcdef1234567890',
  title: 'Checkout verification',
  status: 'failure',
  url: 'https://github.com/acme/checkout/actions/runs/1',
  occurredAt: new Date(Date.now() - 60_000).toISOString(),
};

const settledState = () => ({
  changes: [change],
  nextCursor: null as string | null,
  summary: {
    total: 12,
    failing: 2,
    succeeded: 8,
    latestAt: change.occurredAt as string | null,
  },
  sources: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Primary GitHub',
      provider: 'github',
      enabled: true,
      lastAttemptAt: change.occurredAt,
      lastSuccessAt: change.occurredAt,
      count: 12,
      failureCategory: null,
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Primary GitLab',
      provider: 'gitlab',
      enabled: true,
      lastAttemptAt: change.occurredAt,
      lastSuccessAt: null,
      count: 4,
      failureCategory: 'signature_mismatch',
    },
  ],
  loading: false,
  error: false,
  refetch: vi.fn(),
});
let changesState = settledState();

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'token' }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));
vi.mock('../../lib/useChanges', () => ({
  useChanges: (options: typeof lastOptions) => {
    lastOptions = options;
    return changesState;
  },
}));

import { ChangesPanel } from '../ChangesPanel';

describe('ChangesPanel', () => {
  beforeEach(() => {
    lastOptions = {};
    changesState = settledState();
  });

  test('shows one table skeleton without false empty data on the first load', () => {
    changesState = {
      ...settledState(),
      changes: [],
      nextCursor: null,
      summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
      sources: [],
      loading: true,
    };

    const { container } = render(<ChangesPanel />);

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading changes/i);
    expect(screen.getByRole('status').getAttribute('data-skeleton-variant')).toBe('table');
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(10);
    expect(screen.queryByText(/no github or gitlab data sources/i)).toBeNull();
    expect(screen.queryByLabelText('Repository')).toBeNull();
  });

  test('retains accumulated changes while another page loads', async () => {
    const view = render(<ChangesPanel />);
    expect(await screen.findByText('Checkout verification')).toBeDefined();

    changesState = { ...settledState(), changes: [], nextCursor: 'CUR2', loading: true };
    view.rerender(<ChangesPanel />);

    expect(screen.getByText('Checkout verification')).toBeDefined();
    expect(screen.queryByText('Loading changes…')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load older' })).toBeNull();
  });

  test('shows actionable source health and code-change evidence separately from deployments', async () => {
    render(<ChangesPanel />);

    expect(screen.getByRole('heading', { name: 'Changes' })).toBeDefined();
    expect(screen.getByText(/deployment records remain in Deployments/i)).toBeDefined();
    expect(screen.getByText('Receiving')).toBeDefined();
    expect(screen.getByText('Action required')).toBeDefined();
    expect(screen.getByText(/signature mismatch/i)).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    expect(await screen.findByText('Checkout verification')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Checkout verification' })).toHaveProperty(
      'href',
      'https://github.com/acme/checkout/actions/runs/1',
    );
    expect(screen.getByText(/acme\/checkout · main/)).toBeDefined();
  });

  test('applies independent repository and free-text filters', async () => {
    render(<ChangesPanel />);
    fireEvent.change(screen.getByLabelText('Repository'), {
      target: { value: 'acme/checkout' },
    });
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'timeout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(lastOptions.filters).toMatchObject({
      repository: 'acme/checkout',
      search: 'timeout',
    });
  });
});
