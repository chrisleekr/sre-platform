// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { expect, test, vi } from 'vitest';

import type { IncidentWorkspaceData } from '../../../lib/types';
import { IncidentRelationships } from '../relationships';

test('shows attributed human feedback that changes future correlation', () => {
  const currentId = '11111111-1111-4111-8111-111111111111';
  const otherId = '22222222-2222-4222-8222-222222222222';
  render(
    <MemoryRouter>
      <IncidentRelationships
        workspace={
          {
            incident: { id: currentId, status: 'open' },
            relations: [
              {
                id: 'relation-1',
                sourceIncidentId: currentId,
                targetIncidentId: otherId,
                type: 'unrelated',
                rationale: 'Different traces prove different causes.',
                evidence: ['trace:different'],
                decidedBy: 'human',
                decidedByUserId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                createdAt: '2026-08-31T00:00:00.000Z',
                correlationFeedback: {
                  decision: 'separate',
                  sourceScopeKeys: ['source'],
                  targetScopeKeys: ['target'],
                  sharedScopeKeys: ['shared'],
                },
                targetIncident: {
                  id: otherId,
                  title: 'Prior checkout incident',
                  service: 'checkout',
                  severity: 'sev2',
                  status: 'resolved',
                  investigationStatus: 'assessed',
                  createdAt: '2026-08-30T00:00:00.000Z',
                },
              },
            ],
          } as IncidentWorkspaceData
        }
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );

  expect(
    screen.getByText(/Decision: human · responder aaaaaaaa · future shared scopes: separate/),
  ).toBeDefined();
});

test('shows evidence-backed causal direction without offering merge controls', () => {
  const currentId = '11111111-1111-4111-8111-111111111111';
  const rootId = '22222222-2222-4222-8222-222222222222';
  render(
    <MemoryRouter>
      <IncidentRelationships
        workspace={
          {
            incident: { id: currentId, status: 'open' },
            relations: [
              {
                id: 'causal-relation',
                sourceIncidentId: currentId,
                targetIncidentId: rootId,
                type: 'caused_by',
                rationale: 'Database saturation caused the checkout failures.',
                evidence: ['evidence:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
                evidenceIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
                confidence: 94,
                decisionRunId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                decidedBy: 'agent',
                decidedByUserId: null,
                createdAt: '2026-09-01T00:00:00.000Z',
                targetIncident: {
                  id: rootId,
                  title: 'Database saturation',
                  service: 'database',
                  severity: 'sev2',
                  status: 'open',
                  investigationStatus: 'assessed',
                  createdAt: '2026-09-01T00:00:00.000Z',
                },
              },
            ],
          } as IncidentWorkspaceData
        }
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onChanged={vi.fn()}
      />
    </MemoryRouter>,
  );

  expect(screen.getByText('This incident is a downstream symptom.')).toBeDefined();
  expect(
    screen.getByRole('link', { name: /Open direct cause: Database saturation/ }),
  ).toBeDefined();
  expect(screen.getByText(/94% confidence/)).toBeDefined();
  expect(screen.getByRole('button', { name: 'Reject causal link' })).toBeDefined();
  expect(screen.queryByRole('button', { name: /join|merge/i })).toBeNull();
});
