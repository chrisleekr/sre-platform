// @vitest-environment jsdom
import { expect, test } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GitOpsApplication } from '../../lib/types';
import { GitOpsApplicationsList } from '../GitOpsApplicationsList';

const now = Date.parse('2026-08-23T01:05:00Z');
const application = (
  name: string,
  overrides: Partial<GitOpsApplication> = {},
): GitOpsApplication => ({
  dataSourceId: '00000000-0000-4000-8000-000000000001',
  dataSourceName: 'Primary Argo CD',
  source: 'argocd',
  entityId: `application:default/argocd/${name}`,
  applicationId: `default/argocd/${name}`,
  applicationName: name,
  applicationNamespace: 'argocd',
  project: 'default',
  syncStatus: 'Synced',
  healthStatus: 'Healthy',
  operationPhase: 'Succeeded',
  revisions: ['0123456789abcdef'],
  conditions: [],
  observedAt: '2026-08-23T01:04:30Z',
  ...overrides,
});

test('collapses healthy inventory while keeping stale and degraded applications prominent', () => {
  render(
    <GitOpsApplicationsList
      now={now}
      applications={[
        application('healthy'),
        application('stale', { observedAt: '2026-08-23T01:00:00Z' }),
        application('degraded', { healthStatus: 'Degraded' }),
      ]}
    />,
  );

  expect(screen.getByRole('article', { name: 'stale' })).toBeDefined();
  expect(screen.getByRole('article', { name: 'degraded' })).toBeDefined();
  expect(screen.queryByRole('article', { name: 'healthy' })).toBeNull();
  expect(screen.getByText('Show 1 healthy application')).toBeDefined();
  expect(screen.getByText(/Observed 5m ago.*stale/)).toBeDefined();
});

test('applies the shared evidence search to application identity and revision', () => {
  render(
    <GitOpsApplicationsList
      now={now}
      search="orders"
      applications={[application('checkout'), application('orders')]}
    />,
  );
  expect(screen.getByText('orders')).toBeDefined();
  expect(screen.queryByText('checkout')).toBeNull();
});
