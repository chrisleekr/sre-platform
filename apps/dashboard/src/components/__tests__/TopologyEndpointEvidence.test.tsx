// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TopologyEndpointEvidence } from '../TopologyEndpointEvidence';
import { TopologyDiscoveryCoverage } from '../TopologyEvidence';
import { discoveryFixture } from './topology-discovery.fixture';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const access = {
  apiBaseUrl: '/api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'test' }),
};

test('shows recorded endpoint facts and links to provenance, while refresh only reads the API', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({
      status: 'observed',
      endpoint: 'https://public.example/status',
      note: 'This does not establish service identity.',
      probes: [
        {
          kind: 'http',
          state: 'observed',
          evidenceId: 'evidence',
          incidentId: 'incident',
          tool: 'networkprobe',
          observedAt: new Date().toISOString(),
          stale: true,
          facts: { status: 503 },
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<TopologyEndpointEvidence subjectKey="exact-endpoint" access={access} />);
  expect(await screen.findByText('503')).toBeTruthy();
  expect(screen.getByText('Stale observation')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open source investigation' }).getAttribute('href')).toBe(
    '/w/incidents/incident',
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh evidence' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(
    fetcher.mock.calls.every((call) =>
      String(call[0]).startsWith('/api/topology/endpoint-evidence?'),
    ),
  ).toBe(true);
});

test('reports lookup failure and supports retry without offering a network mutation', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status: 503 }))
    .mockResolvedValue(
      Response.json({
        status: 'unavailable',
        endpoint: null,
        probes: [],
        note: 'No matching probe evidence was recorded.',
      }),
    );
  vi.stubGlobal('fetch', fetcher);
  render(<TopologyEndpointEvidence subjectKey="endpoint" access={access} />);
  await screen.findByRole('alert');
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh evidence' }));
  await screen.findByText('No matching probe evidence was recorded.');
  expect(screen.queryByRole('alert')).toBeNull();
});

test('distinguishes unsupported capabilities from pending collection and on-demand probes', () => {
  const graph = discoveryFixture();
  graph.capabilities = [
    { connectorId: null, name: 'aws', type: 'aws', mode: 'unsupported', state: 'unsupported' },
    {
      connectorId: null,
      name: 'confluence',
      type: 'confluence',
      mode: 'unsupported',
      state: 'unsupported',
    },
    {
      connectorId: null,
      name: 'networkprobe',
      type: 'networkprobe',
      mode: 'on_demand',
      state: 'on_demand',
    },
    {
      connectorId: 'cluster',
      name: 'Cluster',
      type: 'kubernetes',
      mode: 'inventory',
      state: 'pending',
    },
  ];
  render(<TopologyDiscoveryCoverage graph={graph} />);
  expect(screen.getAllByText('Not implemented')).toHaveLength(2);
  expect(screen.getByText('Awaiting first collection')).toBeTruthy();
  expect(screen.getByText('Network probe')).toBeTruthy();
  expect(screen.getByText('On-demand probe evidence')).toBeTruthy();
});
