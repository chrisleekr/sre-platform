// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { BlastRadius } from '@sre/contracts';
import { TopologyImpact } from '../TopologyImpact';
import { IncidentTopologyMatches } from '../incident-conversation/topology-context';
import { discoveryFixture } from './topology-discovery.fixture';

test('unknown call semantics are not presented as synchronous or protected, and selection uses stable keys', () => {
  const result: BlastRadius = {
    service: 'database',
    subjectKey: 'db-prod',
    mapped: true,
    truncated: false,
    dependents: {
      direct: [],
      indirect: [],
      insulated: [],
      unclassified: [
        {
          name: 'api',
          subjectKey: 'api-dev',
          scope: { environment: 'development' },
          team: null,
          criticality: null,
          hops: 1,
        },
      ],
    },
    suspects: [],
  };
  const onSelect = vi.fn();
  render(
    <TopologyImpact
      service="database"
      result={result}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSelect={onSelect}
    />,
  );
  expect(screen.getByRole('heading', { name: 'Dependency behavior unknown (1)' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: /Synchronous exposure/ })).toBeNull();
  expect(screen.getByText(/environment: development/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'api' }));
  expect(onSelect).toHaveBeenCalledWith('api', 'api-dev');
});

test('unresolved identity gives the actual reason, not mandatory manual registration instructions', () => {
  render(
    <TopologyImpact
      service="api"
      result={{
        service: 'api',
        mapped: false,
        truncated: false,
        dependents: { direct: [], indirect: [], insulated: [] },
        suspects: [],
        note: 'Service identity is ambiguous. Select an environment.',
      }}
      loading={false}
      error={null}
      onRetry={vi.fn()}
      onSelect={vi.fn()}
    />,
  );
  expect(screen.getByText('Service identity is ambiguous. Select an environment.')).toBeTruthy();
  expect(screen.queryByText(/Register it/)).toBeNull();
});

test('incident topology links preserve scoped identity and classifier uncertainty', () => {
  const graph = discoveryFixture();
  render(
    <MemoryRouter>
      <IncidentTopologyMatches
        context={{
          subjects: graph.operational.subjects,
          relations: [],
          resolutions: [
            {
              candidateKey: 'incident-prod',
              status: 'resolved',
              subjectKey: 'checkout-prod',
              candidateSubjectKeys: [],
            },
            { candidateKey: 'inference', status: 'needs_evidence', candidateSubjectKeys: [] },
          ],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'checkout' }).getAttribute('href')).toBe(
    '/w/topology?subject=checkout-prod',
  );
  expect(screen.getByText(/environment: production/)).toBeTruthy();
  expect(screen.getByText(/needs corroborating evidence/)).toBeTruthy();
});
