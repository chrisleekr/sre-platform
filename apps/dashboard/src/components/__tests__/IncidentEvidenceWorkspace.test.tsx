// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { EvidenceDetail, EvidenceListItem } from '../../lib/types';
import { IncidentEvidenceWorkspace } from '../IncidentEvidenceWorkspace';

const item: EvidenceListItem = {
  id: 'evidence-1',
  tool: 'prometheus_primary_query_range_with_a_long_machine_identifier',
  outcome: 'data',
  latencyMs: 12,
  recordedAt: '2026-08-29T00:00:00Z',
  hasOutput: true,
};

const detail: EvidenceDetail = {
  ...item,
  input: { query: 'up' },
  output: { status: 'success' },
  projection: {
    kind: 'facts',
    columns: ['status'],
    rows: [{ status: 'success' }],
  },
  referenceUrl: null,
};

describe('IncidentEvidenceWorkspace', () => {
  test('skeletons the evidence ledger before the first recorded check arrives', () => {
    const { container } = render(
      <IncidentEvidenceWorkspace
        evidence={[]}
        details={{}}
        selectedId={null}
        nextCursor={null}
        loading
        error={false}
        paginationError={false}
        detailErrors={{}}
        onOpen={vi.fn()}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole('status').textContent).toMatch(/loading recorded checks/i);
    expect(container.querySelectorAll('.sre-skeleton').length).toBeGreaterThan(4);
    expect(screen.queryByText('No checks recorded yet.')).toBeNull();
  });

  test('keeps the selected record visible while its detail skeleton loads', () => {
    const { container } = render(
      <IncidentEvidenceWorkspace
        evidence={[item]}
        details={{ [item.id]: null }}
        selectedId={item.id}
        nextCursor={null}
        loading={false}
        error={false}
        paginationError={false}
        detailErrors={{}}
        onOpen={vi.fn()}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading evidence detail/i);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    const blocks = container.querySelectorAll('.sre-skeleton');
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const block of blocks) expect(block.getAttribute('aria-hidden')).toBe('true');
  });

  test('selected detail replaces the evidence list instead of nesting reading areas', () => {
    render(
      <IncidentEvidenceWorkspace
        evidence={[item]}
        details={{ [item.id]: detail }}
        selectedId={item.id}
        nextCursor={null}
        loading={false}
        error={false}
        paginationError={false}
        detailErrors={{}}
        onOpen={vi.fn()}
        onLoadOlder={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText('Evidence records')).toBeNull();
    expect(screen.getByRole('table', { name: 'Human-readable evidence facts' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Prometheus' }).className).toContain('break-words');
  });

  test('names the failure reason instead of the raw category', () => {
    const failedItem = {
      ...item,
      tool: 'statuscake_AAAAAAAAAAAAAAAAAAAAAA_get_test',
      outcome: 'error',
      failure: 'not_found',
      hasOutput: false,
    } as EvidenceListItem;
    const failedDetail = {
      ...failedItem,
      input: { type: 'heartbeat', id: '5' },
      output: { failure: 'not_found' },
      projection: { kind: 'facts', columns: ['failure'], rows: [{ failure: 'not_found' }] },
      referenceUrl: null,
    } as EvidenceDetail;
    const props = {
      evidence: [failedItem],
      nextCursor: null,
      loading: false,
      error: false,
      paginationError: false,
      detailErrors: {},
      onOpen: vi.fn(),
      onLoadOlder: vi.fn(),
      onRetry: vi.fn(),
    };

    const list = render(<IncidentEvidenceWorkspace {...props} details={{}} selectedId={null} />);
    expect(screen.getByLabelText('Evidence records').textContent).toMatch(
      /Check failed: not found/,
    );
    list.unmount();

    render(
      <IncidentEvidenceWorkspace
        {...props}
        details={{ [failedItem.id]: failedDetail }}
        selectedId={failedItem.id}
      />,
    );
    expect(screen.getByText(/Check failed: not found/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByText('The source has nothing matching this request as named.'),
    ).toBeDefined();
  });
});
