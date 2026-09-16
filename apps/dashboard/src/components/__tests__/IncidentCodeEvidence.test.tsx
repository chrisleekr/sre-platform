// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import type { EvidenceDetail } from '../../lib/types';
import { IncidentCodeEvidence } from '../IncidentCodeEvidence';

type CodeProjection = Extract<EvidenceDetail['projection'], { kind: 'code' }>;

const revision = 'a'.repeat(40);

function projection(overrides: Partial<CodeProjection> = {}): CodeProjection {
  return {
    kind: 'code',
    status: 'located',
    artifacts: [
      {
        dataSourceName: 'Kubernetes production',
        identity: `registry.example/checkout@sha256:${'b'.repeat(64)}`,
        namespace: 'checkout',
        workload: 'checkout-abc',
        container: 'app',
        revision,
      },
    ],
    revisions: [
      {
        repository: 'acme/checkout',
        role: 'application_source',
        basis: 'artifact_metadata',
        strength: 'verified',
        revision,
        providerUrl: `https://github.com/acme/checkout/commit/${revision}`,
        deployedAt: '2026-08-29T00:00:00Z',
      },
    ],
    matches: [
      {
        repository: 'acme/checkout',
        revision,
        strength: 'verified',
        path: 'src/orders.ts',
        startLine: 38,
        endLine: 48,
        excerpt: '42: throw new Error("account missing")',
        providerUrl: `https://github.com/acme/checkout/blob/${revision}/src/orders.ts#L38-L48`,
        changedFromPreviousRevision: true,
      },
    ],
    uncertainties: [],
    requiredSetup: [],
    ...overrides,
  };
}

describe('IncidentCodeEvidence', () => {
  test('explains discarded source evidence without showing stale excerpts or links', () => {
    render(
      <IncidentCodeEvidence
        projection={projection({
          status: 'source_changed',
          artifacts: [],
          revisions: [],
          matches: [],
          uncertainties: ['Source access changed during the read.'],
          requiredSetup: [
            'Refresh topology source evidence before reading this configuration again.',
          ],
        })}
      />,
    );
    expect(screen.getByText('source changed')).toBeDefined();
    expect(screen.getByText('Source access changed during the read.')).toBeDefined();
    expect(
      screen.getByText('Refresh topology source evidence before reading this configuration again.'),
    ).toBeDefined();
    expect(screen.queryByRole('link', { name: /open exact source/i })).toBeNull();
    expect(screen.queryByText('Repository provenance')).toBeNull();
  });

  test('shows runtime provenance and exact source without overstating causality', () => {
    render(<IncidentCodeEvidence projection={projection()} />);
    const root = screen.getByText('1 source location found').closest('section')!;
    expect(root.className).toContain('@container');
    expect(screen.getByText('Repository provenance').nextElementSibling?.className).toContain(
      '@xl:grid-cols-2',
    );
    expect(screen.getAllByText('acme/checkout').length).toBeGreaterThan(0);
    expect(screen.getByText(/src\/orders.ts:38-48/)).toBeDefined();
    expect(screen.getByText('changed in deploy')).toBeDefined();
    expect(screen.getByText(/throw new Error/)).toBeDefined();
    expect(screen.getByText(/not root-cause proof/i)).toBeDefined();
    expect(screen.getByRole('link', { name: /open exact source/i }).getAttribute('href')).toBe(
      `https://github.com/acme/checkout/blob/${revision}/src/orders.ts#L38-L48`,
    );
  });

  test('makes missing provenance and setup requirements explicit', () => {
    render(
      <IncidentCodeEvidence
        projection={projection({
          status: 'missing_revision',
          artifacts: [],
          revisions: [],
          matches: [],
          uncertainties: ['runtime revision was not available'],
          requiredSetup: ['publish the build commit with the artifact'],
        })}
      />,
    );
    expect(screen.getByText('missing revision')).toBeDefined();
    expect(screen.getByText('runtime revision was not available')).toBeDefined();
    expect(screen.getByText('publish the build commit with the artifact')).toBeDefined();
  });
});
