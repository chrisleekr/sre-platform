// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Incident, IncidentWorkspaceData } from '../../lib/types';
import { assessmentLabel } from '../../lib/incidentState';
import { IncidentOverview } from '../incident-conversation/overview';
import { IncidentControls } from '../incident-conversation/controls';
import type { IncidentLiveViewModel } from '../incident-conversation/view-model';

afterEach(cleanup);

/** Supply canonical state to the real incident projections without network hooks.
 * @param overrides - Server facts for the scenario being rendered.
 */
function view(
  overrides: Partial<Incident> & { purpose?: 'incident' | 'health_check' } = {},
): IncidentLiveViewModel {
  const incident: Incident = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Deployment validation failed',
    service: 'slack:C-OPERATIONS',
    severity: 'sev3',
    status: 'open',
    investigationStatus: 'assessed',
    lifecycleVersion: 0,
    alertSource: 'slack',
    rcaSummary: 'The migration failed its checksum check.',
    confidence: 90,
    createdAt: '2026-09-10T01:00:00.000Z',
    ...overrides,
  };
  const workspace: IncidentWorkspaceData = {
    incident,
    viewerUserId: null,
    signals: [],
    progress: { total: 2, successful: 2, failed: 0, lastRecordedAt: null },
    codeContext: { resolvedServices: ['checkout'], repositories: [], events: [] },
  };
  return {
    incident,
    workspace,
    evidenceState: { evidence: [], details: {} },
    showAllEvidence: vi.fn(),
    assessment: assessmentLabel(incident),
    signals: [],
    navigate: vi.fn(),
    stream: { status: 'open' },
    createdAt: incident.createdAt,
    copyLinkState: 'idle',
    copyIncidentLink: vi.fn(),
    openEvidence: vi.fn(),
    getCredentials: vi.fn(async () => ({ kind: 'bearer', token: 'fixture' })),
    refreshWorkspace: vi.fn(),
    ownershipLabel: 'Open',
    ownershipMarker: '',
    providerState: { marker: '', text: '', label: 'No active signals' },
    activeSignals: [],
    activeSignalCount: 0,
    allSignalsCleared: false,
    lifecycleReason: 'Requested by the responder',
    lifecyclePending: null,
    transitionLifecycle: vi.fn(),
    postmortemTrigger: '',
    mergedTargetId: null,
  } as unknown as IncidentLiveViewModel;
}

describe('truthful incident response state', () => {
  test.each([
    [['Payments'], 'Payments'],
    [[], 'Not established'],
  ] as const)('service-team context is independent of human attention', (teams, expected) => {
    const model = view();
    model.workspace.serviceTeams = [...teams];
    model.workspace.attention = null;
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Service team').parentElement?.textContent).toBe(
      `Service team ${expected}`,
    );
  });

  test('older workspace responses retain the attention-owner service-team fallback', () => {
    const model = view();
    model.workspace.attention = {
      decision: 'Review evidence',
      owner: 'Legacy team',
      nextAutomation: null,
    };
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Service team').parentElement?.textContent).toBe(
      'Service team Legacy team',
    );
  });
  test.each([
    ['inconclusive', 'Inconclusive'],
    ['blocked_missing_capability', 'Blocked by missing capability'],
    ['budget_exhausted', 'Budget exhausted'],
  ] as const)(
    'a latest %s run does not inherit the prior assessment-ready label',
    (outcome, label) => {
      render(
        <MemoryRouter>
          <IncidentOverview
            view={view({
              latestInvestigationRun: {
                id: 'latest',
                operation: 'resume',
                outcome,
                triggerReason: null,
                triggerAutomatic: false,
                triggerMonitorKey: null,
                triggerMonitorKeys: [],
                triggerBudget: null,
                completedAt: '2026-09-10T01:01:00Z',
              },
            })}
          />
        </MemoryRouter>,
      );
      expect(screen.getByText(`Latest follow-up: ${label}`)).toBeTruthy();
      expect(screen.queryByText('Assessment ready')).toBeNull();
      expect(screen.getByText('Last trusted assessment')).toBeTruthy();
    },
  );
  test('processing work does not hide a separately queued responder correction', () => {
    render(
      <MemoryRouter>
        <IncidentOverview
          view={view({
            pendingAutomation: {
              type: 'triage',
              status: 'processing',
              scheduledAt: '2026-09-10T01:00:00Z',
            },
            queuedResponderWork: {
              type: 'resume',
              status: 'queued',
              scheduledAt: '2026-09-10T01:01:00Z',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Investigation recorded as processing')).toBeTruthy();
    expect(
      screen.getByText('Responder follow-up queued. New input has not yet been incorporated.'),
    ).toBeTruthy();
    expect(screen.getByText('Last trusted assessment')).toBeTruthy();
  });
  test('a queued provider reassessment is shown separately from the retained assessment', () => {
    const model = view({
      pendingAutomation: {
        type: 'signal.reassess',
        status: 'queued',
        scheduledAt: '2026-09-10T01:00:00Z',
      },
    });
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Investigation queued')).toBeTruthy();
    expect(screen.queryByText('Assessment ready')).toBeNull();
    expect(screen.getByText('Last trusted assessment')).toBeTruthy();
  });
  test('unconfirmed candidates are deduplicated and labeled as possible affected resources', () => {
    const model = view();
    model.workspace.codeContext = {
      resolvedServices: [model.incident.service],
      repositories: [],
      events: [],
    };
    const candidate = {
      key: 'pod-a',
      kind: 'workload' as const,
      stableId: 'pod-a',
      displayName: 'pod-a',
      scope: {},
      provenance: { kind: 'provider_label' as const, source: 'pod' },
      confidence: 50,
      observedAt: '2026-09-10T00:00:00Z',
      completeness: 'complete' as const,
      requiredCapabilities: [],
    };
    model.workspace.entityContext = {
      observations: [{ signalId: 'signal-a', source: null, candidates: [candidate, candidate] }],
      mappings: [],
      services: [],
      capabilityGaps: [],
    };
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Possible affected resources')).toBeTruthy();
    expect(screen.getAllByText('pod-a')).toHaveLength(1);
  });
  test('an active follow-up is not presented as assessment ready', () => {
    render(
      <MemoryRouter>
        <IncidentOverview
          view={view({
            pendingAutomation: {
              type: 'resume',
              status: 'processing',
              scheduledAt: '2026-09-10T01:05:00.000Z',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.queryByText('Assessment ready')).toBeNull();
    expect(screen.getByText('Investigation recorded as processing')).toBeTruthy();
    expect(screen.getAllByText('The migration failed its checksum check.').length).toBeGreaterThan(
      0,
    );
  });

  test('the handoff card states automation once, matching recorded processing work', () => {
    const model = view({
      pendingAutomation: {
        type: 'triage',
        status: 'processing',
        scheduledAt: '2026-09-10T01:05:00.000Z',
      },
    });
    model.workspace.attention = null;
    model.workspace.automation = {
      nextAction: {
        description: 'Complete the investigation recorded as processing',
        scheduledAt: null,
      },
      currentBudget: null,
      episodeExpiresAt: null,
    } as IncidentWorkspaceData['automation'];
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    const handoff = within(screen.getByRole('region', { name: 'Response handoff and policy' }));
    expect(handoff.getByText('No human decision required')).toBeTruthy();
    expect(handoff.getByText('Complete the investigation recorded as processing')).toBeTruthy();
    expect(handoff.queryByText('Investigation recorded as processing')).toBeNull();
    const recorded = within(screen.getByRole('region', { name: 'Recorded automation' }));
    expect(recorded.getByText('Investigation recorded as processing')).toBeTruthy();
    expect(recorded.queryByText(/Scheduled time/)).toBeNull();
  });

  test.each([
    [
      {
        pendingAutomation: {
          type: 'triage',
          status: 'queued',
          scheduledAt: '2026-09-10T01:05:00.000Z',
        },
      },
      true,
    ],
    [{ recoveryState: 'monitoring', recoveryNextCheckAt: '2026-09-10T01:05:00.000Z' }, true],
    [{ recoveryState: 'verified', recoveryNextCheckAt: '2026-09-10T01:05:00.000Z' }, false],
  ] as const)('shows a scheduled time only for a real schedule: %o', (overrides, shown) => {
    render(
      <MemoryRouter>
        <IncidentOverview view={view(overrides as Partial<Incident>)} />
      </MemoryRouter>,
    );
    const recorded = within(screen.getByRole('region', { name: 'Recorded automation' }));
    expect(Boolean(recorded.queryByText(/Scheduled time/))).toBe(shown);
  });

  test('transport channel identity is not labelled as the affected service', () => {
    render(
      <MemoryRouter>
        <IncidentOverview view={view()} />
      </MemoryRouter>,
    );
    expect(screen.queryByText('slack:C-OPERATIONS')).toBeNull();
    expect(screen.getByText('checkout')).toBeTruthy();
  });

  test('failed follow-up preserves the previous assessment and check count', () => {
    render(
      <MemoryRouter>
        <IncidentOverview view={view({ investigationStatus: 'degraded' })} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Last trusted assessment')).toBeTruthy();
    expect(screen.getAllByText('The migration failed its checksum check.').length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/2 diagnostic checks recorded/)).toBeTruthy();
  });

  test('a failed latest run remains visible when the prior assessment keeps investigation status assessed', () => {
    render(
      <MemoryRouter>
        <IncidentOverview
          view={view({
            investigationStatus: 'assessed',
            latestInvestigationRun: {
              id: 'failed-follow-up',
              operation: 'resume',
              outcome: 'failed',
              triggerReason: null,
              triggerAutomatic: false,
              triggerMonitorKey: null,
              triggerMonitorKeys: [],
              triggerBudget: null,
              completedAt: '2026-09-10T01:05:00Z',
              summary: 'Investigation finalization failed.',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Latest follow-up failed')).toBeTruthy();
    expect(screen.queryByText('Assessment ready')).toBeNull();
    expect(screen.getByText('Last trusted assessment')).toBeTruthy();
    expect(screen.getAllByText('The migration failed its checksum check.').length).toBeGreaterThan(
      0,
    );
  });

  test('health checks have an explicit completion action rather than an outage resolution', () => {
    const model = view({ purpose: 'health_check', title: 'General system health check' });
    render(
      <MemoryRouter>
        <IncidentControls view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /complete health check/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /resolve incident/i })).toBeNull();
  });

  test('a completed health check is not presented as an outage awaiting recovery', () => {
    const model = view({
      purpose: 'health_check',
      status: 'closed',
      recoveryState: 'not_verified',
      title: 'General system health check',
    });
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Completed')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Health check completed' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Recovery not verified' })).toBeNull();
  });
});

test.each([
  ['newer recovery', '2026-09-10T01:01:00Z', '2026-09-10T01:00:00Z', 'incident', true],
  ['equal timestamps', '2026-09-10T01:00:00Z', '2026-09-10T01:00:00Z', 'incident', true],
  ['newer assessment', '2026-09-10T01:00:00Z', '2026-09-10T01:01:00Z', 'incident', false],
  ['undated recovery', null, '2026-09-10T01:00:00Z', 'incident', false],
  ['undated assessment', '2026-09-10T01:01:00Z', null, 'incident', true],
  ['both undated', null, null, 'incident', true],
  ['health check', '2026-09-10T01:01:00Z', '2026-09-10T01:00:00Z', 'health_check', false],
] as const)(
  'retained impact has truthful assessment provenance: %s',
  (_name, recoveryUpdatedAt, assessmentUpdatedAt, purpose, historical) => {
    const model = view({
      purpose,
      impact: 'The deployment was blocked by the migration.',
      assessmentUpdatedAt,
      recoveryUpdatedAt,
      recoveryState: 'verified',
      recoverySummary: 'The migration now passes.',
    });
    render(
      <MemoryRouter>
        <IncidentOverview view={model} />
      </MemoryRouter>,
    );
    expect(Boolean(screen.queryByText('Impact at last assessment'))).toBe(historical);
    const impact = screen.getByText('The deployment was blocked by the migration.').parentElement!;
    if (historical && assessmentUpdatedAt) {
      expect(impact.querySelector('time')?.getAttribute('datetime')).toBe(assessmentUpdatedAt);
    }
    expect(screen.queryByText(/no current impact/i)).toBeNull();
  },
);
