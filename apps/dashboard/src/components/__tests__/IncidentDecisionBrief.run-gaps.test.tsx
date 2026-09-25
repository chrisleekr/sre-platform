// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, within } from '@testing-library/react';
import { IncidentDecisionBrief } from '../IncidentDecisionBrief';
import { InvestigationResult } from '../InvestigationResult';
import type { Incident, IncidentWorkspaceData } from '../../lib/types';

afterEach(cleanup);

const run: NonNullable<Incident['latestInvestigationRun']> = {
  id: '33333333-3333-4333-8333-333333333333',
  operation: 'investigate',
  outcome: 'inconclusive',
  triggerReason: null,
  triggerAutomatic: false,
  triggerMonitorKey: null,
  triggerMonitorKeys: [],
  triggerBudget: null,
  summary: 'Grafana was OOMKilled at 09:12Z; memory at 99.6% of limit at 09:40Z.',
  nextStep: 'Query container RSS against the limit over the last 6 hours.',
  gaps: ['Confirm OOMKilled as the termination reason per restart.', 'Check deployment history.'],
  completedAt: '2026-09-14T00:02:00Z',
};

const workspace: IncidentWorkspaceData = {
  incident: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Grafana restarts',
    service: 'grafana',
    severity: 'sev3',
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 0,
    alertSource: 'manual',
    createdAt: '2026-09-14T00:00:00Z',
    rcaSummary: null,
    confidence: null,
    latestInvestigationRun: run,
  },
  signals: [],
  progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
  viewerUserId: null,
};

test('the brief shows the reviewer conclusion, next step and still-to-verify list', () => {
  const view = render(
    <IncidentDecisionBrief
      workspace={workspace}
      onSelectEvidence={vi.fn()}
      getCredentials={async () => ({ kind: 'bearer' as const, token: 'test' })}
      onChanged={vi.fn()}
    />,
  );
  const result = view.getByRole('region', { name: 'Latest investigation result' });
  expect(within(result).getByText(run.summary!)).toBeTruthy();
  expect(within(result).getByText('Still to verify')).toBeTruthy();
  expect(
    within(result)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(run.gaps);
  expect(view.getByText(run.nextStep!)).toBeTruthy();
});

test('the compact incident-list result omits the gap list', () => {
  const view = render(<InvestigationResult run={run} compact />);
  expect(view.queryByText('Still to verify')).toBeNull();
  expect(view.queryAllByRole('listitem')).toHaveLength(0);
});

test('a run without gaps renders no still-to-verify heading', () => {
  const view = render(<InvestigationResult run={{ ...run, gaps: [] }} />);
  expect(view.queryByText('Still to verify')).toBeNull();
});
