// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TopologyRuntimeEvidence } from '@sre/contracts';
import { TopologySubjectRuntime } from '../TopologySubjectRuntime';
import { discoveryFixture } from './topology-discovery.fixture';
import { installDialogMethods } from '../../test/dialog';

let dialogs: ReturnType<typeof installDialogMethods>;
beforeEach(() => {
  dialogs = installDialogMethods();
});

afterEach(() => {
  cleanup();
  dialogs.restore();
  vi.unstubAllGlobals();
});
const subject = discoveryFixture().operational.subjects.find((row) => row.key === 'checkout-prod')!;
const access = {
  apiBaseUrl: '/api',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'test' }),
};
function evidence(
  state: 'attention' | 'healthy' | 'unknown' = 'attention',
  stale = false,
): TopologyRuntimeEvidence {
  return {
    status: 'partial',
    subject,
    observations: [
      {
        resourceKey: 'pod-uid',
        name: 'checkout-pod',
        kind: 'workload',
        scope: { namespace: 'production' },
        state,
        stale,
        observedAt: new Date().toISOString(),
        sources: [],
      },
    ],
    note: 'Observed resources cannot establish overall service recovery.',
  };
}

test.each([
  ['healthy', false, 'No observed resources need attention.'],
  ['healthy', true, 'No current issues confirmed.'],
  ['unknown', false, 'No current issues confirmed.'],
] as const)(
  'summary distinguishes %s stale=%s without reporting zero attention as an alert',
  async (state, stale, summary) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('/topology/runtime?')
          ? Response.json(evidence(state, stale))
          : Response.json({ workspaces: [] }),
      ),
    );
    render(<TopologySubjectRuntime subject={subject} access={access} />);
    expect(await screen.findByText(new RegExp(summary))).toBeTruthy();
    expect(screen.queryByText(/Needs attention: 0/)).toBeNull();
  },
);

test('shows runtime evidence and requires confirmation before an exact scoped investigation', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.includes('/topology/runtime?')) {
      expect(new URL(path, 'http://localhost').searchParams.get('subjectKey')).toBe(subject.key);
      return Response.json(evidence());
    }
    if (path.endsWith('/observation-workspaces')) return Response.json({ active: [] });
    expect(JSON.parse(String(init?.body))).toEqual({
      subject: { kind: 'topology_service', service: 'checkout', subjectKey: subject.key },
    });
    return Response.json({ error: 'observation is no longer actionable' }, { status: 409 });
  });
  vi.stubGlobal('fetch', fetcher);
  render(<TopologySubjectRuntime subject={subject} access={access} />);
  expect(await screen.findByText('Needs attention')).toBeTruthy();
  expect(screen.getByText(/Coverage is partial/)).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/from-observation'))).toBe(
    false,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Investigate' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start investigation' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => String(path).endsWith('/from-observation'))).toBe(
    true,
  );
});

test.each([
  ['healthy', false],
  ['unknown', false],
  ['attention', true],
] as const)('does not offer new investigations for %s stale=%s', async (state, stale) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      Response.json(String(input).includes('/runtime?') ? evidence(state, stale) : { active: [] }),
    ),
  );
  render(<TopologySubjectRuntime subject={subject} access={access} />);
  await screen.findByText(/Coverage is partial/);
  expect(screen.queryByRole('button', { name: 'Investigate' })).toBeNull();
});

test('discards a late response from the previously selected scope and supports retry', async () => {
  let release: (value: Response) => void = () => {};
  const old = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let fail = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/observation-workspaces')) return Response.json({ active: [] });
      if (path.includes(encodeURIComponent(subject.key))) return old;
      return fail
        ? Response.json({}, { status: 503 })
        : Response.json({ ...evidence('healthy'), observations: [] });
    }),
  );
  const { rerender } = render(<TopologySubjectRuntime subject={subject} access={access} />);
  await waitFor(() => expect(fetch).toHaveBeenCalled());
  rerender(
    <TopologySubjectRuntime subject={{ ...subject, key: 'different-scope' }} access={access} />,
  );
  await screen.findByRole('alert');
  release(Response.json(evidence()));
  expect(screen.queryByText('checkout-pod')).toBeNull();
  fail = false;
  fireEvent.click(await screen.findByRole('button', { name: 'Refresh runtime' }));
  await screen.findByText(/No current runtime observations/);
  expect(screen.queryByText('checkout-pod')).toBeNull();
});

test('keeps an existing investigation reachable when runtime refresh fails', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/observation-workspaces')
        ? Response.json({
            active: [
              {
                kind: 'topology_service',
                sourceId: 'topology-discovery',
                subjectId: 'bounded-hash',
                subjectKey: subject.key,
                incidentId: 'existing-incident',
              },
            ],
          })
        : Response.json({}, { status: 503 }),
    ),
  );
  render(<TopologySubjectRuntime subject={subject} access={access} />);
  await screen.findByRole('alert');
  expect(await screen.findByRole('button', { name: 'Open investigation' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Investigate' })).toBeNull();
});
