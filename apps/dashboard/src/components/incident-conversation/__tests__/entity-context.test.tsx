// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, test, vi } from 'vitest';
import { entityCandidateKey } from '@sre/contracts';
import type { IncidentWorkspaceData } from '../../../lib/types';
import { EntityContextPanel } from '../entity-context';

afterEach(() => vi.unstubAllGlobals());

test('separates the producer from the affected entity and persists a catalog correction', async () => {
  const key = entityCandidateKey('workload', 'worker-7d9f', { namespace: 'jobs' });
  const changed = vi.fn();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/topology/services'))
      return new Response(
        JSON.stringify({
          services: [{ name: 'job-runner', team: 'platform', criticality: 'tier2' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    if (url.endsWith('/entity-mapping')) {
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        candidateKey: key,
        serviceName: 'job-runner',
        rationale: 'This workload belongs to the job runner service.',
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);

  render(
    <MemoryRouter>
      <EntityContextPanel
        workspace={
          {
            incident: { id: '11111111-1111-4111-8111-111111111111' },
            entityContext: {
              observations: [
                {
                  signalId: 'signal-1',
                  source: {
                    kind: 'monitor',
                    provider: 'alertmanager',
                    dataSourceId: null,
                    externalId: 'worker-restarts',
                    displayName: 'Worker restart monitor',
                    observedAt: '2026-08-31T00:00:00.000Z',
                  },
                  candidates: [
                    {
                      key,
                      kind: 'workload',
                      stableId: 'worker-7d9f',
                      displayName: 'worker-7d9f',
                      scope: { namespace: 'jobs' },
                      provenance: { kind: 'provider_label', source: 'pod' },
                      confidence: 90,
                      observedAt: '2026-08-31T00:00:00.000Z',
                      completeness: 'complete',
                      requiredCapabilities: ['runtime', 'logs'],
                    },
                  ],
                },
                {
                  signalId: 'signal-2',
                  source: {
                    kind: 'monitor',
                    provider: 'alertmanager',
                    dataSourceId: null,
                    externalId: 'worker-restarts',
                    displayName: 'Worker restart monitor',
                    observedAt: '2026-08-31T00:05:00.000Z',
                  },
                  candidates: [],
                },
              ],
              mappings: [],
              services: [],
              capabilityGaps: [
                {
                  entityKey: key,
                  capability: 'logs',
                  reason: 'scope_mismatch',
                  summary: 'Configured logs access does not cover this workload.',
                  requiredScope: { kind: 'workload', entity: 'worker-7d9f' },
                  connectors: [],
                  action: { label: 'Adjust data source scope', href: '/connectors' },
                },
              ],
            },
          } as unknown as IncidentWorkspaceData
        }
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onChanged={changed}
      />
    </MemoryRouter>,
  );

  expect(screen.getAllByText('Worker restart monitor')).toHaveLength(1);
  expect(screen.getByText('worker-7d9f')).toBeDefined();
  expect(screen.getByText('Identity: worker-7d9f')).toBeDefined();
  expect(screen.getByText('Scope: namespace=jobs')).toBeDefined();
  expect(screen.getByText(/No catalog service mapping/)).toBeDefined();
  expect(screen.getByText(/does not cover this workload/)).toBeDefined();
  expect(screen.getByRole('link', { name: 'Adjust data source scope' }).getAttribute('href')).toBe(
    '/connectors',
  );

  fireEvent.click(screen.getByRole('button', { name: 'Map to service' }));
  await waitFor(() => expect(screen.getByRole('option', { name: /job-runner/ })).toBeDefined());
  fireEvent.change(screen.getByLabelText('Catalog service'), { target: { value: 'job-runner' } });
  fireEvent.change(screen.getByLabelText('Why is this mapping correct?'), {
    target: { value: 'This workload belongs to the job runner service.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));

  await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
});

test('reveals resolved dependency, repository, deployment, and runbook details', () => {
  render(
    <MemoryRouter>
      <EntityContextPanel
        workspace={
          {
            incident: { id: '11111111-1111-4111-8111-111111111111' },
            entityContext: {
              observations: [],
              mappings: [],
              capabilityGaps: [],
              services: [
                {
                  name: 'checkout',
                  team: 'payments',
                  criticality: 'tier1',
                  dependencies: [
                    { direction: 'downstream', service: 'payments-db', protocol: 'postgres' },
                  ],
                  repositories: [
                    {
                      provider: 'github',
                      fullName: 'acme/checkout',
                      path: 'services/checkout',
                      confirmed: true,
                    },
                  ],
                  deployments: [
                    {
                      source: 'argocd',
                      repository: 'acme/checkout',
                      revision: 'abcdef1234567890',
                      status: 'degraded',
                      url: null,
                      deployedAt: '2026-08-31T00:00:00.000Z',
                    },
                  ],
                  runbooks: [
                    {
                      id: 'runbook-1',
                      title: 'Recover checkout',
                      source: 'runbook://checkout',
                      verified: true,
                    },
                  ],
                },
              ],
            },
          } as unknown as IncidentWorkspaceData
        }
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByText('View resolved context'));
  expect(screen.getByText('downstream · payments-db · postgres')).toBeDefined();
  expect(screen.getByText('github · acme/checkout · services/checkout · confirmed')).toBeDefined();
  expect(screen.getByText('argocd · acme/checkout · abcdef123456 · degraded')).toBeDefined();
  expect(screen.getByText('Recover checkout · verified')).toBeDefined();
});

test('does not render an empty panel for historical signals without entity projections', () => {
  const { container } = render(
    <MemoryRouter>
      <EntityContextPanel
        workspace={
          {
            incident: { id: '11111111-1111-4111-8111-111111111111' },
            entityContext: {
              observations: [{ signalId: 'legacy-signal', source: null, candidates: [] }],
              mappings: [],
              services: [],
              capabilityGaps: [],
            },
          } as unknown as IncidentWorkspaceData
        }
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        onChanged={() => {}}
      />
    </MemoryRouter>,
  );

  expect(container.childElementCount).toBe(0);
});
