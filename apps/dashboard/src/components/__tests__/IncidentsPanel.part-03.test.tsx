// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { MemoryRouter } from 'react-router-dom';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type { Incident } from '../../lib/types';

// The terminal split follows lifecycle, independent of investigation progress.
import { IncidentsPanel } from '../IncidentsPanel';

// The shared auth boundary is a hard dependency of the panel; stub it so the hook wiring doesn't run.
vi.mock('../../auth', () => ({
  useSession: () => ({ getCredentials: async () => ({ kind: 'bearer' as const, token: 'jwt' }) }),
}));

function mk(id: string, status: string, service: string): Incident {
  return {
    id,
    service,
    severity: 'sev2',
    status,
    investigationStatus: status === 'open' ? 'queued' : 'assessed',
    lifecycleVersion: 0,
    alertSource: 'datadog',
    rcaSummary: null,
    confidence: null,
    createdAt: 't',
    requiresHumanAttention: !['resolved', 'closed'].includes(status),
    attentionReason: !['resolved', 'closed'].includes(status) ? 'severity_requires_human' : null,
  };
}

// Each test sets what the mocked hook returns before rendering.
let hookState: {
  incidents: Incident[];
  loading: boolean;
  error: boolean;
  backgroundError?: boolean;
  // true per-scope counts from the server, independent of the (paginated) incidents slice.
  counts?: {
    all?: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  };
} = { incidents: [], loading: false, error: false };

// Swappable hook impl: defaults to returning hookState (args ignored). The Load-more test swaps in a
// cursor-aware page source; renderPanel resets it to the default so the other tests are unaffected.
let useIncidentsMock: (opts: {
  state?: 'open' | 'closed' | 'all';
  attention?: 'human' | 'automation';
  cursor?: string;
  query?: string;
  severity?: string;
  limit?: number;
  pollMs?: number;
}) => {
  incidents: Incident[];
  loading: boolean;
  error: boolean;
  backgroundError?: boolean;
  counts?: {
    all?: number;
    open: number;
    needsHuman?: number;
    automation?: number;
    closed: number;
  };
  nextCursor?: string | null;
} = () => hookState;

vi.mock('../../lib/useIncidents', () => ({
  useIncidents: (opts: {
    state?: 'open' | 'closed' | 'all';
    cursor?: string;
    query?: string;
    severity?: string;
  }) => useIncidentsMock(opts),
}));

afterEach(() => {
  cleanup();
});

// [RED]: the announcer delta is the RAW keyset page length, but the Closed render is partitionThreads'd
// (IncidentsPanel.tsx:19-29) so a still-open row in a closed page is dropped from the list. When a page is
// MIXED, the announced delta over-counts: it says "3 loaded" while only 2 rows actually appear. The delta
// must count the RENDERED closed rows, not the raw fetched page.
describe('IncidentsPanel mixed-page delta announces the rendered closed count', () => {
  // Per-scope TOTALS from the server, NOT a page delta — 42 excludes the raw-length and total collisions.
  const counts = { open: 0, closed: 42 };
  const page1 = [mk('ca', 'resolved', 'alpha'), mk('cb', 'closed', 'bravo')];
  // A MIXED closed page: two closed rows + one still-open row. partitionThreads drops the open row from the
  // Closed render, so 3 rows are fetched but only 2 appear. Raw length (3) ≠ rendered delta (2).
  const page2mixed = [
    mk('cc', 'resolved', 'charlie'),
    mk('cd', 'resolved', 'delta'),
    mk('co', 'open', 'oscar'), // still open — filtered out of the Closed list by partitionThreads
  ];

  function renderMixedArchive() {
    useIncidentsMock = ({ state, cursor }) => {
      if (state !== 'closed') {
        return { incidents: [], loading: false, error: false, counts, nextCursor: null };
      }
      return cursor
        ? { incidents: page2mixed, loading: false, error: false, counts, nextCursor: 'CUR3' }
        : { incidents: page1, loading: false, error: false, counts, nextCursor: 'CUR2' };
    };
    return render(
      <MemoryRouter>
        <IncidentsPanel />
      </MemoryRouter>,
    );
  }

  test('the delta counts only the rendered closed rows, not the raw fetched page', () => {
    const { unmount } = renderMixedArchive();

    fireEvent.click(screen.getByRole('tab', { name: 'Closed' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    // Prove the mixed page appended: its two closed rows render, its open row does NOT.
    expect(screen.getByText('charlie')).toBeDefined();
    expect(screen.getByText('delta')).toBeDefined();
    expect(screen.queryByText('oscar')).toBeNull(); // dropped by partitionThreads

    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toMatch(/\b2\b/); // the RENDERED closed delta
    expect(text).toMatch(/more incidents loaded/i);
    expect(text).not.toMatch(/\b3\b/); // NOT the raw page length (includes the open row)
    expect(text).not.toMatch(/\b4\b/); // NOT the accumulated closed total (2 + 2)
    expect(text).not.toMatch(/\b42\b/); // NOT counts.closed, the server's scope total

    unmount();
  });
});
