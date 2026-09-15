import { TopologyCoverage } from '../TopologyCoverage';
// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TopologyRuntimeManager } from '../TopologyRuntimeManager';
import { TopologyIncidentMapping } from '../TopologyIncidentMapping';
import { TopologyHistory } from '../TopologyHistory';
import { TopologyReliability } from '../TopologyReliability';
import type { TopologyGraph } from '../../lib/topology';

const credentials = async () => ({ kind: 'bearer' as const, token: 'test' });
const base = { apiBaseUrl: 'http://api', getCredentials: credentials };
const graph: TopologyGraph = {
  nodes: [
    { name: 'checkout', team: null, criticality: null, lastDeployAt: null, recentDeploys: [] },
  ],
  edges: [],
  infrastructure: [
    {
      dataSourceId: 'cluster',
      dataSourceName: 'Cluster',
      source: 'kubernetes',
      entityId: 'apps/web',
      namespace: 'apps',
      labels: { app: 'web' },
      kind: 'pod',
      phase: 'Running',
      metrics: { ready: 1 },
      observedAt: new Date().toISOString(),
    },
  ],
};
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(Response.json({}));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

test('registers a new service atomically with exact runtime scope and keeps error recovery in place', async () => {
  const onSaved = vi.fn();
  fetchMock.mockResolvedValueOnce(
    Response.json({ error: 'Selector already assigned' }, { status: 409 }),
  );
  render(<TopologyRuntimeManager {...base} graph={graph} onSaved={onSaved} />);
  change('Service name', 'api');
  change('Connection and namespace', JSON.stringify(['cluster', 'apps']));
  change('Pods to associate', JSON.stringify(['app', 'web']));
  change('Environment', 'production');
  change('Why these resources belong to this service', 'Confirmed application config');
  fireEvent.click(screen.getByRole('button', { name: 'Register service and map runtime' }));
  await screen.findByRole('alert');
  expect(onSaved).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Service name') as HTMLInputElement).value).toBe('api');
  fireEvent.click(screen.getByRole('button', { name: 'Register service and map runtime' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
    serviceName: 'api',
    createService: true,
    replaceExisting: false,
    connectorId: 'cluster',
    namespace: 'apps',
    labelKey: 'app',
    labelValue: 'web',
    environment: 'production',
    rationale: 'Confirmed application config',
  });
});

test('saved selectors remain editable when current pod inventory is missing; removal can be cancelled', async () => {
  render(
    <TopologyRuntimeManager
      {...base}
      onSaved={vi.fn()}
      graph={{
        ...graph,
        infrastructure: [],
        runtimeBindings: [
          {
            id: 'mapping',
            connectorId: 'cluster',
            serviceName: 'checkout',
            namespace: 'apps',
            labelKey: 'app',
            labelValue: 'web',
            environment: 'production',
            rationale: 'Existing mapping',
            updatedAt: new Date().toISOString(),
          },
        ],
      }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Edit mapping' }));
  expect((screen.getByLabelText('Connection and namespace') as HTMLSelectElement).value).toBe(
    JSON.stringify(['cluster', 'apps']),
  );
  expect((screen.getByLabelText('Pods to associate') as HTMLSelectElement).value).toBe(
    JSON.stringify(['app', 'web']),
  );
  change('Environment', 'staging');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm runtime mapping' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toMatchObject({
    replaceExisting: true,
    environment: 'staging',
  });
  await screen.findByText('Runtime mapping saved.');
  expect((screen.getByLabelText('Service name') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Connection and namespace') as HTMLSelectElement).disabled).toBe(
    false,
  );
  change('Service name', 'another-service');
  change('Connection and namespace', JSON.stringify(['cluster', 'apps']));
  change('Pods to associate', JSON.stringify(['app', 'web']));
  change('Environment', 'production');
  change('Why these resources belong to this service', 'New explicit confirmation');
  fireEvent.click(screen.getByRole('button', { name: 'Register service and map runtime' }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).replaceExisting).toBe(false);
  await screen.findByText('Runtime mapping saved.');
  fireEvent.click(screen.getByRole('button', { name: 'Remove mapping' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

test('incident linking requires an explicit service and rationale, and offers provider restoration', async () => {
  const onSaved = vi.fn();
  render(
    <TopologyIncidentMapping
      {...base}
      incidentId="incident"
      services={[]}
      graph={graph}
      onSaved={onSaved}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Link affected service' }));
  expect(
    (screen.getByRole('button', { name: 'Save affected services' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('checkbox', { name: 'checkout' }));
  change('Reason for this change', 'Confirmed service from logs');
  fireEvent.click(screen.getByRole('button', { name: 'Save affected services' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
    services: ['checkout'],
    rationale: 'Confirmed service from logs',
  });
  fireEvent.click(screen.getByRole('button', { name: 'Link affected service' }));
  fireEvent.click(screen.getByRole('button', { name: 'Restore provider mapping' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
  expect(JSON.parse(fetchMock.mock.calls[1]![1].body).services).toEqual([]);
});

test('history submits a concrete time and has a direct return to live topology', () => {
  const onChange = vi.fn();
  render(<TopologyHistory {...base} at="2026-09-01T00:00:00Z" onChange={onChange} />);
  change('Local date and time', '2026-09-01T12:00');
  fireEvent.click(screen.getByRole('button', { name: 'View recorded relationships' }));
  expect(onChange).toHaveBeenCalledWith(new Date('2026-09-01T12:00').toISOString());
  fireEvent.click(screen.getByRole('button', { name: 'Return to live topology' }));
  expect(onChange).toHaveBeenLastCalledWith('');
});

test('historical timestamp and return action stay visible when history controls are collapsed', () => {
  const onChange = vi.fn();
  render(<TopologyHistory at="2026-09-12T01:00:00.000Z" onChange={onChange} {...base} />);
  const summary = screen.getByText('Historical declarations', { exact: true });
  const details = summary.closest('details')!;
  expect(details.open).toBe(true);
  expect((screen.getByLabelText('Local date and time') as HTMLInputElement).value).not.toBe('');
  fireEvent.click(summary);
  expect(
    screen.getByRole('button', { name: 'Return to live topology' }).closest('details'),
  ).toBeNull();
});

test('reliability shows the supporting query, stale evaluation and failure rather than implying health', async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      objectives: [
        {
          name: 'Request availability',
          target: 0.999,
          windowDays: 30,
          metricQuery: 'sum(rate(request_errors[5m]))',
          connectorType: 'prometheus',
          lastEvaluationError: 'Connection unavailable',
          evaluation: {
            budgetRemaining: 0.5,
            burnRate: 2,
            computedAt: new Date(Date.now() - 3600_000).toISOString(),
          },
        },
      ],
    }),
  );
  render(<TopologyReliability {...base} service="checkout" />);
  await screen.findByText('Request availability');
  expect(screen.getByText('sum(rate(request_errors[5m]))')).toBeDefined();
  expect(screen.getByText(/Evaluation is stale/)).toBeDefined();
  expect(screen.getByText('Evaluation failed: Connection unavailable')).toBeDefined();
});

test.each(['partial', 'unknown', 'unavailable', 'complete'] as const)(
  'stale inventory retains its %s collection state',
  (state) => {
    render(
      <TopologyCoverage
        sources={[
          {
            dataSourceId: 'cluster',
            dataSourceName: 'Cluster',
            state,
            observedAt: new Date(Date.now() - 3600_000).toISOString(),
            lastSucceededAt: null,
          },
        ]}
      />,
    );
    const label = {
      partial: 'Partial inventory',
      unknown: 'Collection completeness unknown',
      unavailable: 'Current inventory unavailable',
      complete: 'Complete pod inventory',
    }[state];
    expect(screen.getByText(new RegExp(label)).textContent).toContain('Inventory is stale');
    expect(screen.getByText(/1 of 1 sources need attention/)).toBeTruthy();
  },
);
