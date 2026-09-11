// @vitest-environment jsdom
// The Error budgets panel. It REPORTS reliability: every figure on it resolves to a stored burn
// event that came from an SLI query the operator wrote, and nothing on the page acts on a burning
// budget. There is deliberately no button here that opens an incident, pages anyone, or blocks a
// deploy: the budget is a read model.
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SloEvaluation, SloRow } from '../../lib/types';
import { formatAbsoluteTime } from '../../lib/time';

const h = vi.hoisted(() => ({
  slos: [] as SloRow[],
  loading: false,
  error: false,
  errorStatus: null as number | null,
  backgroundError: false,
}));

vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'cookie' as const }) }),
}));
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));
vi.mock('../../lib/useSloStatus', () => ({
  useSloStatus: () => ({
    slos: h.slos,
    loading: h.loading,
    error: h.error,
    errorStatus: h.errorStatus,
    backgroundError: h.backgroundError,
  }),
}));

import { ErrorBudgetsPanel } from '../ErrorBudgetsPanel';

// `computedAt` defaults to render time so a fixture reads as a fresh evaluation unless a test is
// specifically about staleness.
const evaluation = (over: Partial<SloEvaluation> = {}): SloEvaluation => ({
  budgetRemaining: 0.25,
  burnRate: 4,
  burnWindow: '1h',
  exhaustionDays: 1.875,
  computedAt: new Date().toISOString(),
  ...over,
});

const row = (over: Partial<SloRow> = {}): SloRow => ({
  id: `slo-${over.name ?? 'checkout'}`,
  name: 'checkout-availability',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  enabled: true,
  lastEvaluationError: null,
  evaluationFailingSince: null,
  evaluation: evaluation(),
  ...over,
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.slos = [];
  h.loading = false;
  h.error = false;
  h.errorStatus = null;
  h.backgroundError = false;
});

describe('ErrorBudgetsPanel page states', () => {
  test('uses one page heading and a polite first-load status', () => {
    h.loading = true;
    render(<ErrorBudgetsPanel />);

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Error budgets' })).toBeDefined();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading error budgets/i);
  });

  test('reports a retrieval failure on an initial failure', () => {
    h.error = true;
    render(<ErrorBudgetsPanel />);

    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('alert').textContent).toMatch(/failed to load error budgets/i);
  });

  test('explains a tenant-membership 403 instead of a generic retrieval failure', () => {
    h.error = true;
    h.errorStatus = 403;
    render(<ErrorBudgetsPanel />);

    expect(screen.getByRole('alert').textContent).toMatch(/tenant access/i);
    expect(screen.getByRole('alert').textContent).toMatch(/assigned to exactly one tenant/i);
  });

  test('explains what an objective is when the tenant has defined none', () => {
    render(<ErrorBudgetsPanel />);

    // Empty is a real state, not an error: the tenant simply has not written an objective yet.
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByText(/no error budgets/i)).toBeDefined();
  });
});

describe('ErrorBudgetsPanel rows', () => {
  test('names each objective with its service, target and window', () => {
    h.slos = [row()];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText('checkout-availability')).toBeDefined();
    expect(screen.getByText('checkout')).toBeDefined();
    expect(screen.getByText(/99\.9%/)).toBeDefined();
    expect(screen.getByText(/30d/)).toBeDefined();
  });

  test('shows remaining budget, current burn and the projected exhaustion', () => {
    h.slos = [row()];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/25\.0% budget/i)).toBeDefined();
    expect(screen.getByText(/4\.0x/)).toBeDefined();
    expect(screen.getByText(/1\.9/)).toBeDefined();
  });

  test('states an over-budget objective as an overage, never as a negative percentage', () => {
    h.slos = [
      row({
        evaluation: evaluation({ budgetRemaining: -0.5, burnRate: 20, exhaustionDays: 0 }),
      }),
    ];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/over budget by 50\.0%/i)).toBeDefined();
    expect(screen.queryByText(/-50/)).toBeNull();
  });

  test('an unevaluated objective is labelled as awaiting evaluation, not shown as zero', () => {
    h.slos = [row({ evaluation: null })];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/awaiting first evaluation/i)).toBeDefined();
    expect(screen.queryByText(/budget remaining/i)).toBeNull();
    expect(screen.queryByText(/0\.0%/)).toBeNull();
  });

  test('marks a disabled objective, because the evaluator no longer refreshes it', () => {
    h.slos = [row({ enabled: false })];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/disabled/i)).toBeDefined();
  });

  test('renders every objective the tenant owns', () => {
    h.slos = [
      row({ id: 'a', name: 'checkout-availability' }),
      row({ id: 'b', name: 'orders-latency', service: 'ordersdb', sliType: 'latency' }),
    ];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText('checkout-availability')).toBeDefined();
    expect(screen.getByText('orders-latency')).toBeDefined();
  });

  test('separates healthy, at-risk and exhausted budgets in text, not by colour alone', () => {
    // A budget at 5% and one at 95% must not read identically until the moment it goes negative.
    h.slos = [
      row({
        id: 'ok',
        name: 'healthy-objective',
        evaluation: evaluation({ budgetRemaining: 0.95, burnRate: 0.2, exhaustionDays: null }),
      }),
      row({
        id: 'warn',
        name: 'nearly-spent-objective',
        evaluation: evaluation({ budgetRemaining: 0.05, burnRate: 6, exhaustionDays: 0.25 }),
      }),
      row({
        id: 'gone',
        name: 'over-objective',
        evaluation: evaluation({ budgetRemaining: -0.2, burnRate: 12, exhaustionDays: 0 }),
      }),
    ];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText('Healthy')).toBeDefined();
    expect(screen.getByText('At risk')).toBeDefined();
    expect(screen.getByText('Over budget')).toBeDefined();
  });

  test('the at-risk state is a warning, not a critical failure: the budget is not gone yet', () => {
    h.slos = [
      row({
        evaluation: evaluation({ budgetRemaining: 0.05, burnRate: 6, exhaustionDays: 0.25 }),
      }),
    ];
    render(<ErrorBudgetsPanel />);

    const badge = screen.getByText('At risk');
    expect(badge.className).toMatch(/bg-warning-muted/);
    expect(badge.className).toMatch(/text-warning/);
    expect(badge.className).not.toMatch(/critical/);
  });

  test('an objective awaiting its first evaluation carries no budget state at all', () => {
    h.slos = [row({ evaluation: null })];
    render(<ErrorBudgetsPanel />);

    for (const label of ['Healthy', 'At risk', 'Over budget']) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  test('offers no affordance implying the platform acts on a burning budget', () => {
    h.slos = [
      row({
        evaluation: evaluation({ budgetRemaining: -0.9, burnRate: 40, exhaustionDays: 0 }),
      }),
    ];
    render(<ErrorBudgetsPanel />);

    // A budget that has been blown is exactly where a "declare incident" or "freeze deploys" button
    // would be tempting. Measurement does not need an ingress.
    for (const label of [
      /declare/i,
      /open incident/i,
      /create incident/i,
      /page /i,
      /roll ?back/i,
      /freeze/i,
      /block/i,
    ]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });
});

// A failed evaluator run writes no burn event, so the panel keeps serving the last one. Without the
// age beside it, a figure frozen days ago is indistinguishable from one computed a minute ago, and a
// responder reads a dead number as the current state of the service.
describe('ErrorBudgetsPanel evaluation freshness', () => {
  const at = (iso: string) => row({ evaluation: evaluation({ computedAt: iso }) });

  test('dates a fresh evaluation and does not mark it stale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T01:05:00.000Z'));
    h.slos = [at('2026-08-18T01:00:00.000Z')];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/evaluated/i).textContent).toMatch(/5m ago/);
    expect(screen.queryByText('Stale')).toBeNull();
  });

  test('marks an evaluation older than several cadences so a frozen figure cannot read as current', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T02:00:00.000Z'));
    h.slos = [at('2026-08-18T01:00:00.000Z')];
    render(<ErrorBudgetsPanel />);

    expect(screen.getByText(/evaluated/i).textContent).toMatch(/1h ago/);
    // The word carries the state; colour is only the secondary cue, so it survives a monochrome read.
    const badge = screen.getByText('Stale');
    expect(badge.className).toMatch(/bg-warning-muted/);
    expect(badge.className).toMatch(/text-warning/);
  });

  test('exposes the exact evaluation time through one semantic time element', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T01:05:00.000Z'));
    const computedAt = '2026-08-18T01:00:00.000Z';
    h.slos = [at(computedAt)];
    const { container } = render(<ErrorBudgetsPanel />);

    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(computedAt);
    expect(time?.getAttribute('title')).toBe(formatAbsoluteTime(computedAt));
  });

  test('an objective awaiting its first evaluation states no age at all', () => {
    h.slos = [row({ evaluation: null })];
    render(<ErrorBudgetsPanel />);

    expect(screen.queryByText(/evaluated /i)).toBeNull();
    expect(screen.queryByText('Stale')).toBeNull();
  });
});

// Evaluation is best-effort by design: a rejected query writes no burn event and never dead-letters.
// Before this, an objective with a broken query was indistinguishable on the page from one that had
// simply never run, and the only signal was a worker log line the operator cannot reach.
const failureText = (container: HTMLElement): string =>
  Array.from(container.querySelectorAll('p'))
    .map((p) => p.textContent ?? '')
    .find((text) => text.includes('Evaluation failing')) ?? '';

describe('a failing evaluation is visible on the panel', () => {
  test('states the reason the last attempt failed', () => {
    h.slos = [row({ lastEvaluationError: 'query did not resolve to a numeric ratio' })];
    const { container } = render(<ErrorBudgetsPanel />);

    // The heading and the message are separate nodes in one paragraph, so assert on the paragraph.
    expect(failureText(container)).toContain('Evaluation failing');
    expect(failureText(container)).toContain('query did not resolve to a numeric ratio');
  });

  test('keeps the last good figures beside the failure, never instead of them', () => {
    // A failing objective still serves its last measurement. Replacing the number with the error
    // would hide the budget the responder came to read.
    h.slos = [
      row({
        evaluation: evaluation({ budgetRemaining: 0.25 }),
        lastEvaluationError: 'backend unreachable',
      }),
    ];
    const { container } = render(<ErrorBudgetsPanel />);

    expect(screen.getByText('25.0% budget left')).toBeTruthy();
    expect(failureText(container)).toContain('backend unreachable');
  });

  test('distinguishes a failing never-evaluated objective from one merely waiting', () => {
    h.slos = [
      row({ id: 'a', name: 'waiting', evaluation: null }),
      row({
        id: 'b',
        name: 'broken',
        evaluation: null,
        lastEvaluationError: 'no prometheus connector exposes an SLI reader',
      }),
    ];
    render(<ErrorBudgetsPanel />);

    expect(screen.getAllByText('Awaiting first evaluation')).toHaveLength(2);
    // Only the broken one carries a reason, which is the whole distinction.
    expect(screen.getAllByText('Evaluation failing')).toHaveLength(1);
  });

  test('a healthy objective shows no failure line', () => {
    h.slos = [row()];
    render(<ErrorBudgetsPanel />);

    expect(screen.queryByText('Evaluation failing')).toBeNull();
  });

  test('the failure carries the time of the attempt as a semantic time element', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T01:05:00.000Z'));
    const at = '2026-08-18T01:04:00.000Z';
    h.slos = [
      row({
        evaluation: null,
        lastEvaluationError: 'backend unreachable',
        evaluationFailingSince: at,
      }),
    ];
    const { container } = render(<ErrorBudgetsPanel />);

    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(at);
    expect(time?.getAttribute('title')).toBe(formatAbsoluteTime(at));
  });

  test('there is still no control that acts on a failing objective', () => {
    // The panel reports. A failure is information, not an affordance to retry, page or open anything.
    h.slos = [row({ lastEvaluationError: 'backend unreachable' })];
    render(<ErrorBudgetsPanel />);

    expect(screen.queryAllByRole('button')).toEqual([]);
  });
});
