// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';
import { IncidentsList } from '../IncidentsList';
import { IncidentControls } from '../incident-conversation/controls';
import type { IncidentLiveViewModel } from '../incident-conversation/view-model';
import type { Incident } from '../../lib/types';

const incident = {
  id: 'resolution-policy-fixture',
  service: 'checkout',
  severity: 'sev3',
  status: 'resolved',
  investigationStatus: 'assessed',
  lifecycleVersion: 1,
  alertSource: 'slack',
  createdAt: '2026-09-20T00:00:00Z',
  rcaSummary: null,
  confidence: null,
  signalCount: 1,
  activeSignalCount: 0,
  resolutionPolicy: 'provider_clear',
  resolutionBasis: 'provider_clear',
  recoveryState: 'verified',
  recoveryUpdatedAt: '2026-09-19T00:00:00Z',
};

test('provider-only resolution is explicit and does not present historical health as currently verified', () => {
  render(
    <MemoryRouter>
      <IncidentsList incidents={[incident as Incident]} />
    </MemoryRouter>,
  );
  expect(screen.getByText(/resolved from provider signals/i)).toBeTruthy();
  expect(screen.getByText(/health not independently verified/i)).toBeTruthy();
  expect(screen.queryByText('Recovery verified', { exact: true })).toBeNull();
});

test('active incident lifecycle controls expose the explicit resolution policy', () => {
  const view = {
    incident: {
      ...incident,
      status: 'open',
      resolutionPolicy: 'verified_recovery',
      resolutionBasis: null,
    },
    lifecycleReason: 'Use the agreed monitoring criterion.',
    lifecyclePending: null,
    postmortemTrigger: '',
    archiveReason: '',
    signalCorrectionReason: '',
    activeSignalCount: 0,
    activeSignals: [],
    allSignalsCleared: false,
    mergedTargetId: null,
    setLifecycleReason: vi.fn(),
    setPostmortemTrigger: vi.fn(),
    transitionLifecycle: vi.fn(),
    resolutionPolicy: 'verified_recovery',
    setResolutionPolicy: vi.fn(),
    changeResolutionPolicy: vi.fn(),
  } as unknown as IncidentLiveViewModel;
  render(
    <MemoryRouter>
      <IncidentControls view={view} />
    </MemoryRouter>,
  );
  expect(screen.getByRole('combobox', { name: /resolution policy/i })).toBeTruthy();
  expect(screen.getByRole('option', { name: /provider signals clear/i })).toBeTruthy();
  expect(screen.getByRole('option', { name: /verified recovery/i })).toBeTruthy();
});

test('closing a provider-resolved record retains the closed lifecycle label and its health caveat', () => {
  render(
    <MemoryRouter>
      <IncidentsList incidents={[{ ...incident, status: 'closed' } as Incident]} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Closed', { exact: true })).toBeTruthy();
  expect(screen.getByText('Health not independently verified', { exact: true })).toBeTruthy();
});
