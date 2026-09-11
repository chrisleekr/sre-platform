// @vitest-environment jsdom
import { describe, expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Deployment, Incident } from '../../lib/types';
import { DeploymentEvidenceTimeline, relatedIncidentsFor } from '../DeploymentEvidenceTimeline';

const deployedAt = '2026-08-23T01:02:03Z';
const deployment: Deployment = {
  dataSourceName: 'Primary Argo CD',
  source: 'argocd',
  providerId: 'app:4',
  service: 'checkout',
  repo: 'default/argocd/checkout',
  ref: 'main',
  sha: '0123456789abcdef',
  revisions: ['v2', '0123456789abcdef'],
  operationPhase: 'Succeeded',
  status: 'success',
  transientEnvironment: false,
  actor: 'automated sync',
  deployedAt,
  url: 'https://argocd.example/applications/argocd/checkout',
};

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: crypto.randomUUID(),
    service: 'checkout',
    severity: 'sev2',
    status: 'open',
    investigationStatus: 'gathering',
    lifecycleVersion: 1,
    alertSource: 'prometheus',
    title: 'Checkout latency',
    rcaSummary: null,
    confidence: null,
    createdAt: '2026-08-23T02:02:03Z',
    ...overrides,
  };
}

describe('DeploymentEvidenceTimeline', () => {
  test('correlates only the same service inside the explicit 24-hour window', () => {
    const related = incident();
    const otherService = incident({ service: 'orders' });
    const tooLate = incident({ createdAt: '2026-08-25T02:02:03Z' });

    expect(relatedIncidentsFor(deployment, [related, otherService, tooLate])).toEqual([related]);
  });

  test('opens complete evidence without claiming deployment impact', () => {
    const onSelect = vi.fn();
    const related = incident();
    const { rerender } = render(
      <MemoryRouter>
        <DeploymentEvidenceTimeline
          deployments={[deployment]}
          incidents={[related]}
          applications={[]}
          selected={null}
          onSelect={onSelect}
        />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: /checkout.*success.*argocd/i }));
    expect(onSelect).toHaveBeenCalledWith(deployment);

    rerender(
      <MemoryRouter>
        <DeploymentEvidenceTimeline
          deployments={[deployment]}
          incidents={[related]}
          applications={[]}
          selected={deployment}
          onSelect={onSelect}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText('Unavailable from source')).toBeDefined();
    expect(screen.getByText('v2, 0123456789abcdef')).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'Checkout latency' })).toHaveLength(2);
    expect(
      screen.getByText(/does not infer impact from deployment proximity alone/i),
    ).toBeDefined();
    expect(screen.getByRole('link', { name: 'Open provider evidence' }).getAttribute('href')).toBe(
      deployment.url,
    );
  });
});
