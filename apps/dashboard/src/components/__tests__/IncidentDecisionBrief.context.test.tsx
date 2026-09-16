// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { IncidentDecisionBrief } from '../IncidentDecisionBrief';
import type { IncidentWorkspaceData } from '../../lib/types';

afterEach(cleanup);
const id = '22222222-2222-4222-8222-222222222222';
const workspace: IncidentWorkspaceData = {
  incident: {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Checkout latency',
    service: 'checkout',
    severity: 'sev2',
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 0,
    alertSource: 'manual',
    createdAt: '2026-09-14T00:00:00Z',
    assessmentUpdatedAt: '2026-09-14T00:01:00Z',
    rcaSummary: null,
    confidence: null,
    rankedHypotheses: [
      {
        hypothesis: 'Hypothesis A',
        evidence: 'First claim',
        confidence: 60,
        state: 'leading',
        supportingEvidenceIds: [id],
        contradictingEvidenceIds: [],
      },
      {
        hypothesis: 'Hypothesis B',
        evidence: 'Different claim',
        confidence: 20,
        state: 'plausible',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [id],
      },
    ],
    unknowns: [
      {
        question: 'Missing historical comparison',
        category: 'historical_gap',
        evidenceKind: null,
        attemptedEvidenceIds: [id],
      },
    ],
  },
  signals: [],
  progress: { total: 1, successful: 1, failed: 0, lastRecordedAt: null },
  viewerUserId: null,
};
const credentials = async () => ({ kind: 'bearer' as const, token: 'test' });

test('each shared-ID citation preserves its originating hypothesis or gap in both layouts', () => {
  const selected = vi.fn();
  const view = render(
    <IncidentDecisionBrief
      workspace={workspace}
      onSelectEvidence={selected}
      getCredentials={credentials}
      onChanged={vi.fn()}
    />,
  );
  for (const layout of view.container.querySelectorAll('[data-hypothesis-layout]')) {
    for (const [name, prefix] of [
      ['Hypothesis A', 'Supports'],
      ['Hypothesis B', 'Contradicts'],
    ]) {
      const row = within(layout as HTMLElement)
        .getByText(name!)
        .closest('article,tr')!;
      fireEvent.click(row.querySelector('a')!);
      expect(selected).toHaveBeenLastCalledWith(id, `${prefix} hypothesis: ${name}`);
    }
  }
  const gap = view.getByText('Missing historical comparison').closest('li')!;
  fireEvent.click(gap.querySelector('a')!);
  expect(selected).toHaveBeenLastCalledWith(id, 'Evidence gap: Missing historical comparison');
});

test('current recovery with no next step does not promote a historical rollback instruction', () => {
  const incident = {
    ...workspace.incident,
    recoveryState: 'verifying' as const,
    recoveryUpdatedAt: '2026-09-14T00:02:00Z',
    recoveryNextStep: null,
    nextStep: 'Old rollback instruction',
    latestInvestigationRun: { nextStep: 'Old rollback instruction' } as NonNullable<
      IncidentWorkspaceData['incident']['latestInvestigationRun']
    >,
  };
  const view = render(
    <IncidentDecisionBrief
      workspace={{ ...workspace, incident }}
      onSelectEvidence={vi.fn()}
      getCredentials={credentials}
      onChanged={vi.fn()}
    />,
  );
  expect(view.queryByText('Old rollback instruction')).toBeNull();
});

test('a pending human decision does not replace the recorded diagnostic step', () => {
  const view = render(
    <IncidentDecisionBrief
      workspace={{
        ...workspace,
        incident: { ...workspace.incident, nextStep: 'Compare p95 latency with the last deploy' },
        attention: {
          decision: 'Approve or deny the pending proposed action.',
          owner: null,
          nextAutomation: null,
        },
      }}
      onSelectEvidence={vi.fn()}
      getCredentials={credentials}
      onChanged={vi.fn()}
    />,
  );
  expect(view.getByText('Next diagnostic step').nextElementSibling?.textContent).toBe(
    'Compare p95 latency with the last deploy',
  );
  expect(view.queryByText('Approve or deny the pending proposed action.')).toBeNull();
});
