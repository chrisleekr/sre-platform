// @vitest-environment jsdom
// The work queue is a read model: it shows counts and dead jobs, links each dead job to its
// incident, and offers no retry or edit control of its own.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { DeadJob, DeadJobPage, QueueHealth } from '@sre/contracts';

// One getter for every render: a new function each render would re-run the load effect per response.
vi.mock('../../auth', () => {
  const getCredentials = async () => ({ kind: 'bearer' as const, token: 'jwt' });
  return { useSession: () => ({ getCredentials }) };
});
vi.mock('../../config', () => ({ config: { apiBaseUrl: 'http://api.test' } }));

import { WorkQueuePanel } from '../WorkQueuePanel';

const INCIDENT = '7a6a355c-69b7-4dcc-9928-ea670d9e83a8';
const recent = new Date(Date.now() - 5 * 60_000).toISOString();

const deadJob = (over: Partial<DeadJob> = {}): DeadJob => ({
  id: crypto.randomUUID(),
  type: 'resume',
  attempts: 3,
  incidentId: INCIDENT,
  incidentTitle: 'Checkout errors',
  lastError: 'engine timed out',
  createdAt: recent,
  updatedAt: recent,
  ...over,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function serve(routes: { health: () => Response; dead: (cursor: string | null) => Response }) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    return url.pathname === '/queue/health'
      ? routes.health()
      : routes.dead(url.searchParams.get('cursor'));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

const renderPanel = () =>
  render(
    <MemoryRouter>
      <WorkQueuePanel />
    </MemoryRouter>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('WorkQueuePanel', () => {
  test('shows per-type counts and links each dead job to its incident', async () => {
    const health: QueueHealth = {
      asOf: recent,
      types: [
        { type: 'resume', queued: 2, processing: 1, dead: 1, oldestDueAt: recent },
        { type: 'poll', queued: 0, processing: 1, dead: 0, oldestDueAt: null },
      ],
    };
    serve({
      health: () => json(health),
      dead: () =>
        json({
          jobs: [deadJob(), deadJob({ type: 'poll', incidentId: null, incidentTitle: null })],
          nextCursor: null,
        } satisfies DeadJobPage),
    });
    renderPanel();

    expect(screen.getByRole('heading', { level: 1, name: 'Work queue' })).toBeDefined();
    await screen.findByRole('link', { name: 'Checkout errors' });
    const [summary, dead] = screen.getAllByRole('table');
    const resumeRow = within(summary!).getByText('resume').closest('tr')!;
    expect(
      within(resumeRow)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['resume', '2', '1', '1', '5m ago']);
    expect(within(summary!).getByText('Nothing waiting')).toBeDefined();

    const link = within(dead!).getByRole('link', { name: 'Checkout errors' });
    expect(link.getAttribute('href')).toBe(`/w/incidents/${INCIDENT}`);
    expect(within(dead!).getByText('No incident')).toBeDefined();
    expect(within(dead!).getAllByText('engine timed out')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  test('appends the next page of dead jobs on Load more', async () => {
    const fetcher = serve({
      health: () => json({ asOf: recent, types: [] }),
      dead: (cursor) =>
        cursor === 'page-2'
          ? json({ jobs: [deadJob({ incidentTitle: 'Older failure' })], nextCursor: null })
          : json({ jobs: [deadJob({ incidentTitle: 'Newest failure' })], nextCursor: 'page-2' }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    expect(await screen.findByRole('link', { name: 'Older failure' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Newest failure' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/queue/dead?limit=25&cursor=page-2'),
      expect.anything(),
    );
  });

  test('says so when there is nothing outstanding and nothing dead', async () => {
    serve({
      health: () => json({ asOf: recent, types: [] }),
      dead: () => json({ jobs: [], nextCursor: null }),
    });
    renderPanel();

    expect(await screen.findByText('Nothing queued, running or dead.')).toBeDefined();
    expect(await screen.findByText('No dead jobs.')).toBeDefined();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  test('reports a failed load for each section and retries it', async () => {
    let healthy = false;
    serve({
      health: () => (healthy ? json({ asOf: recent, types: [] }) : json({}, 503)),
      dead: () => json({}, 503),
    });
    renderPanel();

    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));
    expect(screen.getByText('Failed to load queue health.')).toBeDefined();
    expect(screen.getByText('Failed to load dead jobs.')).toBeDefined();

    healthy = true;
    const healthAlert = screen.getByText('Failed to load queue health.').closest('[role="alert"]')!;
    fireEvent.click(within(healthAlert as HTMLElement).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Nothing queued, running or dead.')).toBeDefined();
  });

  test('Refresh reloads the counts and restarts the dead-job list from its first page', async () => {
    let generation = 1;
    serve({
      health: () =>
        json({
          asOf: recent,
          types:
            generation === 1
              ? []
              : [{ type: 'resume', queued: 4, processing: 0, dead: 0, oldestDueAt: recent }],
        }),
      dead: (cursor) =>
        cursor === 'page-2'
          ? json({ jobs: [deadJob({ incidentTitle: 'Older failure' })], nextCursor: null })
          : json({
              jobs: [
                deadJob({ incidentTitle: generation === 1 ? 'First failure' : 'New failure' }),
              ],
              nextCursor: 'page-2',
            }),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await screen.findByRole('link', { name: 'Older failure' });

    generation = 2;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('link', { name: 'New failure' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'First failure' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Older failure' })).toBeNull();
    expect(await screen.findByText('4')).toBeDefined();
  });
});
