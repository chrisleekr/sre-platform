// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TopologyIncidentSelection } from '../TopologyIncidentSelection';
import { discoveryFixture } from './topology-discovery.fixture';
import type { TopologyGraph } from '../../lib/topology';
import type { TopologyIncidentSelection as Selection } from '@sre/contracts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, '', '/');
});
const getCredentials = async () => ({ kind: 'bearer' as const, token: 'test' });
function props() {
  const graph: TopologyGraph = {
    nodes: [],
    edges: [],
    discovery: discoveryFixture(),
    incidents: ['first', 'second'].map((id) => ({
      id,
      title: `${id} incident`,
      service: 'slack:conversation',
      severity: 'sev3',
      status: 'open',
      purpose: 'incident',
      archivedAt: null,
      alertSource: 'slack',
      createdAt: new Date().toISOString(),
    })),
  };
  return {
    graph,
    access: { apiBaseUrl: '/api', getCredentials },
    onSelect: vi.fn(),
    onRefresh: vi.fn(),
  };
}
function result(incidentId = 'first', ambiguous = false): Selection {
  const discovery = discoveryFixture();
  return {
    incidentId,
    assignedServices: [],
    topology: {
      resolutions: [
        {
          candidateKey: 'candidate',
          status: ambiguous ? 'ambiguous' : 'resolved',
          ...(ambiguous ? {} : { subjectKey: 'checkout-prod' }),
          candidateSubjectKeys: ambiguous ? ['checkout-prod', 'checkout-dev'] : [],
        },
      ],
      subjects: discovery.operational.subjects.filter(
        (subject) =>
          subject.key === 'checkout-prod' || (ambiguous && subject.key === 'checkout-dev'),
      ),
      relations: [],
    },
  };
}
const choose = (id: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: 'Incident scope' }), {
    target: { value: id },
  });

test('loads only the chosen incident and opens its exact scoped identity without catalog setup', async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL) => Response.json(result()));
  vi.stubGlobal('fetch', fetch);
  const input = props();
  render(<TopologyIncidentSelection {...input} />);
  expect(fetch).not.toHaveBeenCalled();
  choose('first');
  const inspect = await screen.findByRole('button', { name: 'Inspect checkout' });
  expect(screen.getByText('service · environment: production')).toBeTruthy();
  expect(screen.queryByText(/environment: development/)).toBeNull();
  fireEvent.click(inspect);
  expect(input.onSelect).toHaveBeenCalledWith('checkout-prod');
  expect(fetch.mock.calls[0]?.[0]).toBe('/api/topology/incidents/first/context');
  expect(window.location.search).toBe('?incident=first');
  expect(screen.queryByRole('button', { name: 'Save affected services' })).toBeNull();
});

test('ambiguous matches remain candidates with their separate environments', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(result('first', true))),
  );
  const input = props();
  render(<TopologyIncidentSelection {...input} />);
  choose('first');
  await screen.findByText(/0 matched subjects · 2 possible matches/);
  const matches = within(
    screen.getByRole('list', { name: 'Incident topology matches' }),
  ).getAllByRole('listitem');
  expect(matches).toHaveLength(2);
  expect(screen.queryByText('Matched identity')).toBeNull();
  fireEvent.click(within(matches[1]!).getByRole('button', { name: 'Inspect checkout' }));
  expect(input.onSelect).toHaveBeenCalledWith('checkout-dev');
});

test('a failed refresh keeps last matches visible but prevents inspecting stale authorization', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(result()))
    .mockResolvedValue(new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  render(<TopologyIncidentSelection {...props()} />);
  choose('first');
  await screen.findByText('Matched identity');
  fireEvent.click(screen.getByRole('button', { name: 'Refresh incident matches' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'last successfully loaded matches',
  );
  expect(
    (screen.getByRole('button', { name: 'Inspect checkout' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test('a late response from the previous incident cannot appear under a newly selected incident', async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.includes('/first/')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(Response.json(result('second', true))),
    ),
  );
  render(<TopologyIncidentSelection {...props()} />);
  choose('first');
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  choose('second');
  await screen.findByText(/2 possible matches/);
  finish(Response.json(result('first')));
  await waitFor(() => expect(screen.queryByText('Matched identity')).toBeNull());
  expect(screen.getByRole('link', { name: 'Open incident' }).getAttribute('href')).toBe(
    '/w/incidents/second',
  );
});

test('missing incident reads offer recovery without showing a fabricated match', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 })),
  );
  render(<TopologyIncidentSelection {...props()} />);
  choose('first');
  expect((await screen.findByRole('alert')).textContent).toContain('unavailable in this workspace');
  expect(screen.queryByRole('button', { name: 'Inspect checkout' })).toBeNull();
});
