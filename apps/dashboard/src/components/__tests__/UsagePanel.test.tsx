// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LlmUsageSummary } from '@sre/contracts';

const usage: LlmUsageSummary = {
  from: '2026-07-27T00:00:00.000Z',
  to: '2026-08-26T00:00:00.000Z',
  invocations: 9,
  succeeded: 8,
  failed: 1,
  unpriced: 1,
  missingUsage: 2,
  configuredCostUsd: 2.036331,
  providerEstimatedCostUsd: 2.691936,
  tokens: { input: 100_000, output: 50_000, cacheRead: 627_511, cacheWrite: 50_064 },
  series: [
    {
      bucketAt: '2026-08-25T00:00:00.000Z',
      invocations: 9,
      failed: 1,
      configuredCostUsd: 2.036331,
      tokens: 827_575,
    },
  ],
  byOperation: [
    { operation: 'reassess', invocations: 2, configuredCostUsd: 1.156231, unpriced: 0 },
    { operation: 'investigate', invocations: 2, configuredCostUsd: 0.607923, unpriced: 1 },
  ],
  byModel: [
    {
      runtime: 'claude-agent-sdk',
      provider: 'anthropic',
      model: 'claude-opus-5',
      invocations: 9,
      configuredCostUsd: 2.036331,
      unpriced: 1,
    },
  ],
};

const h = vi.hoisted(() => ({
  usage: null as LlmUsageSummary | null,
  loading: false,
  error: false,
  errorStatus: null as number | null,
  refetch: vi.fn(),
  lastOptions: null as null | { from: string; to: string },
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));
vi.mock('../../lib/useLlmUsage', () => ({
  useLlmUsage: (options: { from: string; to: string }) => {
    h.lastOptions = { from: options.from, to: options.to };
    return {
      usage: h.usage,
      loading: h.loading,
      error: h.error,
      errorStatus: h.errorStatus,
      refetch: h.refetch,
    };
  },
}));

import { UsagePanel } from '../UsagePanel';

afterEach(() => {
  cleanup();
  h.usage = usage;
  h.loading = false;
  h.error = false;
  h.errorStatus = null;
  h.refetch.mockReset();
  h.lastOptions = null;
});

describe('UsagePanel', () => {
  test('renders cost, token quality, workload, and model evidence outside Settings', () => {
    h.usage = usage;
    render(<UsagePanel />);

    expect(screen.getByRole('heading', { level: 1, name: 'Usage & Cost' })).toBeDefined();
    expect(screen.getAllByText('$2.04').length).toBeGreaterThan(1);
    expect(screen.getAllByTitle('Exact configured value: $2.036331').length).toBeGreaterThan(1);
    expect(screen.getByText('$2.69')).toBeDefined();
    expect(screen.getAllByText('827,575')).toHaveLength(2);
    expect(screen.getByText('Reassess evidence')).toBeDefined();
    expect(screen.getByText('Initial investigation')).toBeDefined();
    expect(screen.getByText('claude-opus-5')).toBeDefined();
    expect(screen.getByText(/Anthropic · Claude Agent SDK/)).toBeDefined();
    expect(
      screen.getByText(/1 invocation\(s\) have token usage but no configured price/i),
    ).toBeDefined();
    expect(screen.getByText(/2 invocation\(s\) have not reported token usage/i)).toBeDefined();
    expect(screen.getByText(/reference only, not a billing statement/i)).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Cost over time' })).toBeDefined();
    expect(screen.getByRole('img', { name: 'Daily configured model cost' })).toBeDefined();
    expect(screen.getByText(/Daily configured cost in UTC/i)).toBeDefined();
  });

  test('positions sparse daily costs by calendar time instead of array index', () => {
    h.usage = {
      ...usage,
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
      series: [
        { ...usage.series[0]!, bucketAt: '2026-08-01T00:00:00.000Z' },
        { ...usage.series[0]!, bucketAt: '2026-08-02T00:00:00.000Z' },
        { ...usage.series[0]!, bucketAt: '2026-08-30T00:00:00.000Z' },
      ],
    };
    const { container } = render(<UsagePanel />);

    const positions = [...container.querySelectorAll('svg rect')].map((bar) =>
      Number(bar.getAttribute('x')),
    );
    expect(positions).toHaveLength(3);
    expect(positions[2]! - positions[1]!).toBeGreaterThan((positions[1]! - positions[0]!) * 10);
  });

  test('keeps the loading state separate from report content', () => {
    h.usage = usage;
    h.loading = true;
    const { container } = render(<UsagePanel />);

    expect(screen.getByRole('status').textContent).toMatch(/loading usage and cost/i);
    expect(container.querySelector('[data-page-state="loading"]')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'Summary' })).toBeNull();
    expect(screen.queryByText(/no model usage in this time range/i)).toBeNull();
  });

  test('labels a missing provider estimate instead of presenting it as zero cost', () => {
    h.usage = { ...usage, providerEstimatedCostUsd: null };
    render(<UsagePanel />);

    expect(screen.getByText('Not reported')).toBeDefined();
    expect(screen.getByText(/reference only, not a billing statement/i)).toBeDefined();
    expect(screen.queryByText('$2.691936')).toBeNull();
  });

  test('changes preset windows and validates a custom date range before querying it', () => {
    h.usage = usage;
    render(<UsagePanel />);
    const initial = h.lastOptions!;

    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: '7' } });
    const sevenDays = h.lastOptions!;
    expect(new Date(sevenDays.to).getTime() - new Date(sevenDays.from).getTime()).toBe(
      7 * 86_400_000,
    );
    expect(sevenDays.from).not.toBe(initial.from);

    fireEvent.change(screen.getByLabelText('Time range'), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-20' } });
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/start date must not be after/i);
    expect(h.lastOptions).toEqual(sevenDays);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/choose both dates/i);
    expect(h.lastOptions).toEqual(sevenDays);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2025-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert').textContent).toMatch(/366 days or less/i);
    expect(h.lastOptions).toEqual(sevenDays);

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-08-01' } });
    fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-08-10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.queryByRole('alert')).toBeNull();
    const custom = h.lastOptions!;
    expect(new Date(custom.to).getTime() - new Date(custom.from).getTime()).toBe(
      10 * 86_400_000 - 1,
    );
  });

  test('shows an operator-specific access state without offering a retry', () => {
    h.usage = usage;
    h.error = true;
    h.errorStatus = 403;
    render(<UsagePanel />);

    expect(screen.getByRole('alert').textContent).toMatch(/platform-operator access is required/i);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  test('offers a retry for a report failure and an honest empty-range state', () => {
    h.usage = usage;
    h.error = true;
    h.errorStatus = 500;
    const { rerender } = render(<UsagePanel />);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(h.refetch).toHaveBeenCalledOnce();

    h.error = false;
    h.errorStatus = null;
    h.usage = { ...usage, invocations: 0, byOperation: [], byModel: [] };
    rerender(<UsagePanel />);
    expect(screen.getByText(/no model usage in this time range/i)).toBeDefined();
  });

  test('shows running invocations without calling incomplete telemetry a completed failure', () => {
    h.usage = {
      ...usage,
      invocations: 10,
      missingUsage: 1,
    };
    render(<UsagePanel />);

    expect(screen.getByText(/8 succeeded, 1 failed, 1 running/i)).toBeDefined();
    expect(screen.getByText(/can include work still running/i)).toBeDefined();
  });
});
