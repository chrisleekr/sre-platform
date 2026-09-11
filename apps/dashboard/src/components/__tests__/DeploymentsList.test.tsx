// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { DeploymentsList } from '../DeploymentsList';
import type { Deployment } from '../../lib/types';
import { formatAbsoluteTime } from '../../lib/time';

const succeeded: Deployment = {
  dataSourceName: 'Primary GitHub',
  source: 'github',
  repo: 'acme/checkout',
  ref: 'main',
  sha: 'a1b2c3d',
  status: 'success',
  transientEnvironment: false,
  deployedAt: new Date().toISOString(),
  url: 'https://github.com/acme/checkout/actions/runs/1',
};
const failed: Deployment = {
  dataSourceName: 'Primary GitLab',
  source: 'gitlab',
  providerId: '9001',
  repo: 'acme/orders',
  environment: 'production',
  actor: 'deploy-bot',
  ref: 'release',
  sha: 'e4f5a6b',
  status: 'failed',
  transientEnvironment: false,
  deployedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
};
const running: Deployment = {
  dataSourceName: 'Primary GitHub',
  source: 'github',
  repo: 'acme/cart',
  ref: 'feature/x',
  sha: '0c1d2e3',
  status: 'running',
  transientEnvironment: false,
  deployedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DeploymentsList', () => {
  test('renders repo, ref and short sha for each deployment', () => {
    render(<DeploymentsList deployments={[succeeded, failed, running]} />);
    for (const d of [succeeded, failed, running]) {
      expect(screen.getByText(d.repo)).toBeDefined();
      expect(screen.getByText(d.ref)).toBeDefined();
      expect(screen.getByText(d.sha)).toBeDefined();
    }
  });

  test('shows a status badge for each pipeline status', () => {
    render(<DeploymentsList deployments={[succeeded, failed, running]} />);
    expect(screen.getByText('success')).toBeDefined();
    expect(screen.getByText('failed')).toBeDefined();
    expect(screen.getByText('running')).toBeDefined();
  });

  test('renders every deployment status as text, never color alone', () => {
    const statuses: Deployment['status'][] = [
      'success',
      'failed',
      'failure',
      'error',
      'running',
      'pending',
      'blocked',
      'canceled',
      'inactive',
    ];
    render(
      <DeploymentsList
        deployments={statuses.map((status, index) => ({
          ...succeeded,
          status,
          sha: `sha-${index}`,
          deployedAt: new Date(Date.now() - index * 1_000).toISOString(),
        }))}
      />,
    );

    for (const status of statuses) expect(screen.getByText(status)).toBeDefined();
  });

  test('orders deployments most-recent-first', () => {
    const older: Deployment = {
      ...succeeded,
      repo: 'acme/older',
      deployedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    };
    const newer: Deployment = {
      ...succeeded,
      repo: 'acme/newer',
      deployedAt: new Date().toISOString(),
    };
    render(<DeploymentsList deployments={[older, newer]} />);
    // Assert order via the list's text content (type-safe under noUncheckedIndexedAccess).
    const text = screen.getByRole('list').textContent ?? '';
    expect(text.indexOf('acme/newer')).toBeLessThan(text.indexOf('acme/older'));
  });

  test('shows an empty state when there are no deployments', () => {
    render(<DeploymentsList deployments={[]} />);
    expect(screen.getByText('No deployments yet.')).toBeDefined();
  });

  test('explains what will populate an empty deployment history (C2)', () => {
    render(<DeploymentsList deployments={[]} />);

    expect(screen.getByText('No deployments yet.')).toBeDefined();
    expect(screen.getByText(/deployment activity.*appear here/i)).toBeDefined();
  });

  test('links an http(s) deploy url', () => {
    render(<DeploymentsList deployments={[succeeded]} />);
    const link = screen.getByRole('link', { name: succeeded.sha });
    expect(link.getAttribute('href')).toBe(succeeded.url);
  });

  test('does not link a javascript: url (href-scheme XSS guard)', () => {
    const malicious: Deployment = {
      ...succeeded,
      repo: 'acme/evil',
      sha: 'deadbee',
      url: 'javascript:alert(1)',
    };
    render(<DeploymentsList deployments={[malicious]} />);
    // The sha renders as plain text, never an anchor, so the javascript: scheme can't execute.
    expect(screen.getByText('deadbee').tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('shows every current deployment field as visible text in one row', () => {
    render(<DeploymentsList deployments={[succeeded]} />);

    expect(screen.getAllByRole('table')).toHaveLength(1);
    const row = screen.getByText(succeeded.repo).closest('tr')!;
    for (const value of [succeeded.repo, succeeded.ref, succeeded.sha, succeeded.status]) {
      expect(within(row).getByText(value)).toBeDefined();
    }
    expect(within(row).getByText(succeeded.dataSourceName)).toBeDefined();
    expect(within(row).getByText(/github · Actor not reported/)).toBeDefined();
  });

  test('shows GitLab environment and actor for fast incident correlation', () => {
    render(<DeploymentsList deployments={[failed]} />);

    const row = screen.getByText(failed.repo).closest('tr')!;
    expect(within(row).getByText('production')).toBeDefined();
    expect(within(row).getByText(/gitlab · deploy-bot/)).toBeDefined();
    expect(row.querySelector('[data-label="Environment"]')).not.toBeNull();
    expect(row.querySelector('[data-label="Source"]')).not.toBeNull();
  });

  test('surfaces canonical service identity and opens the evidence inspector', () => {
    const onSelect = vi.fn();
    const deployment = { ...succeeded, service: 'checkout-api' };
    render(<DeploymentsList deployments={[deployment]} onSelect={onSelect} />);

    expect(screen.getByText('checkout-api')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(onSelect).toHaveBeenCalledWith(deployment);
  });

  test('shows a transient environment independently from deployment status', () => {
    render(
      <DeploymentsList
        deployments={[{ ...succeeded, environment: 'preview-42', transientEnvironment: true }]}
      />,
    );

    const row = screen.getByText(succeeded.repo).closest('tr')!;
    expect(within(row).getByText('preview-42')).toBeDefined();
    expect(within(row).getByText('transient')).toBeDefined();
    expect(within(row).getByText('success')).toBeDefined();
  });

  test('shows ordered ArgoCD revisions and completed operation phase', () => {
    render(
      <DeploymentsList
        deployments={[
          {
            ...succeeded,
            source: 'argocd',
            repo: 'payments/argocd/checkout',
            ref: 'main, production',
            revisions: ['release-app', 'release-config'],
            operationPhase: 'Succeeded',
          },
        ]}
      />,
    );

    const row = screen.getByText('payments/argocd/checkout').closest('tr')!;
    expect(within(row).getByText('main, production')).toBeDefined();
    expect(within(row).getByRole('link', { name: 'release-app +1' })).toBeDefined();
    expect(within(row).getByRole('link', { name: 'release-app +1' }).getAttribute('title')).toBe(
      'release-app, release-config',
    );
    expect(row.querySelector('[data-label="Environment"]')).toBeNull();
    expect(within(row).getByText('Succeeded')).toBeDefined();
  });

  test('uses an explicit fallback when the API supplies an empty ref', () => {
    render(<DeploymentsList deployments={[{ ...succeeded, ref: '' }]} />);

    expect(screen.getByText('No ref reported')).toBeDefined();
  });

  test('renders relative and exact deployment time through one semantic time element', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-18T01:05:00.000Z'));
    const deployedAt = '2026-08-18T01:00:00.000Z';
    const { container } = render(<DeploymentsList deployments={[{ ...succeeded, deployedAt }]} />);

    const time = container.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe(deployedAt);
    expect(time?.getAttribute('title')).toBe(formatAbsoluteTime(deployedAt));
    expect(time?.textContent).toBe('5m ago');
    expect(screen.getByText(formatAbsoluteTime(deployedAt))).toBeDefined();
  });

  test('uses source-sensitive row keys for otherwise identical deployments', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const shared: Deployment = {
      ...succeeded,
      repo: 'acme/shared',
      sha: 'same-sha',
      deployedAt: '2026-08-18T01:00:00.000Z',
      url: undefined,
    };

    render(
      <DeploymentsList
        deployments={[
          { ...shared, source: 'github' },
          { ...shared, source: 'gitlab' },
        ]}
      />,
    );

    expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/i);
  });

  test.each([
    ['HTTP', 'http://ci.example.test/runs/1'],
    ['HTTPS', 'https://ci.example.test/runs/1'],
  ])('links the SHA for an absolute %s pipeline URL', (_scheme, url) => {
    render(<DeploymentsList deployments={[{ ...succeeded, url }]} />);

    expect(screen.getByRole('link', { name: succeeded.sha }).getAttribute('href')).toBe(url);
  });

  test.each([
    ['missing', undefined],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,unsafe'],
    ['relative', '/pipelines/1'],
    ['non-HTTP', 'ftp://ci.example.test/runs/1'],
  ])('renders a %s pipeline URL as a plain SHA', (_case, url) => {
    render(<DeploymentsList deployments={[{ ...succeeded, url }]} />);

    expect(screen.getByText(succeeded.sha).tagName).toBe('SPAN');
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('uses one labelled semantic table row per deployment with compact wrapping seams', () => {
    const longRepo = 'acme/checkout-edge-router-with-a-long-uninterrupted-repository-name';
    const { container } = render(
      <DeploymentsList
        deployments={[
          { ...succeeded, repo: longRepo },
          { ...failed, repo: 'acme/orders' },
        ]}
      />,
    );

    expect(screen.getAllByRole('table')).toHaveLength(1);
    expect(screen.getAllByText(longRepo)).toHaveLength(1);
    const row = screen.getByText(longRepo).closest('tr')!;
    const labels = [
      'Status',
      'Service',
      'Provider target',
      'Environment',
      'Revision',
      'Source',
      'Deployed',
    ];
    for (const label of labels) {
      expect(row.querySelector(`[data-label="${label}"]`)).not.toBeNull();
    }
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.getAttribute('data-label')),
    ).toEqual(labels);
    expect(row.className).toMatch(/grid|block/);
    expect(row.className).toMatch(/sm:table-row|md:table-row/);
    expect(row.querySelector('[data-label="Provider target"]')?.className).toMatch(
      /break-words|break-all/,
    );
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });
});

// The advisory error-budget stamp on a deploy row. It is INFORMATION, not a gate: the platform
// cannot stop a deploy and must not imply that it can. The column follows the `Environment` pattern
// and appears only when at least one deploy in the list actually carries a stamp, so a tenant with no
// objectives sees the table exactly as before.
describe('DeploymentsList budget-risk stamp', () => {
  const stamped = (over: Partial<Deployment> = {}): Deployment => ({
    ...succeeded,
    repo: 'acme/risky',
    sha: 'b1b2c3d',
    budgetRemaining: 0.05,
    highRisk: true,
    ...over,
  });

  test('shows no budget column when no deploy carries a stamp', () => {
    const { container } = render(<DeploymentsList deployments={[succeeded, failed]} />);

    expect(container.querySelector('[data-label="Budget"]')).toBeNull();
    expect(screen.queryByText(/budget/i)).toBeNull();
  });

  test('labels a high-risk deploy as advisory and shows the remaining budget figure', () => {
    render(<DeploymentsList deployments={[stamped()]} />);

    // The literal word "advisory" is the guard: it is what stops the badge reading as an enforcement.
    expect(screen.getByText(/high risk \(advisory\)/i)).toBeDefined();
    expect(screen.getByText(/5\.0%/)).toBeDefined();
  });

  test('states an over-budget stamp as an overage, the same wording the budgets panel uses', () => {
    render(<DeploymentsList deployments={[stamped({ budgetRemaining: -0.25 })]} />);

    // budgetRemaining is signed, so formatting it directly would render "-25.0% left".
    expect(screen.getByText(/over budget by 25\.0%/i)).toBeDefined();
    expect(screen.queryByText(/-25/)).toBeNull();
  });

  test('shows the figure without the badge when the budget is healthy', () => {
    render(<DeploymentsList deployments={[stamped({ budgetRemaining: 0.62, highRisk: false })]} />);

    expect(screen.getByText(/62\.0%/)).toBeDefined();
    expect(screen.queryByText(/high risk/i)).toBeNull();
  });

  test('an unstamped deploy in a stamped list shows no figure and no badge', () => {
    const { container } = render(
      <DeploymentsList deployments={[stamped(), { ...succeeded, repo: 'acme/plain' }]} />,
    );

    // The column exists because another row is stamped, but this row asserts nothing about a budget
    // it never measured.
    const cells = container.querySelectorAll('[data-label="Budget"]');
    expect(cells).toHaveLength(2);
    expect(cells[1]!.textContent).not.toMatch(/%|high risk/i);
  });

  test('the badge is a warning, not a critical failure: the deploy still happened', () => {
    render(<DeploymentsList deployments={[stamped()]} />);

    const badge = screen.getByText(/high risk \(advisory\)/i);
    expect(badge.className).toMatch(/bg-warning-muted/);
    expect(badge.className).toMatch(/text-warning/);
    expect(badge.className).not.toMatch(/critical/);
  });

  test('offers no affordance implying the platform can stop, block or roll back the deploy', () => {
    render(<DeploymentsList deployments={[stamped({ budgetRemaining: -0.2 })]} />);

    for (const label of [/block/i, /roll ?back/i, /freeze/i, /cancel/i, /abort/i, /revert/i]) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
      expect(screen.queryByRole('link', { name: label })).toBeNull();
    }
  });
});
