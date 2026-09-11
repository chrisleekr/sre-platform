// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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
    expect(screen.getByText('Investigation in progress')).toBeTruthy();
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
    expect(screen.getByText(/investigat.*(?:progress|running)|gathering evidence/i)).toBeTruthy();
    expect(screen.getAllByText('The migration failed its checksum check.').length).toBeGreaterThan(
      0,
    );
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
