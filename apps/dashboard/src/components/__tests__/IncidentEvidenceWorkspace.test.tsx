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

    expect(screen.getByText('Prometheus')).toBeDefined();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toMatch(/loading evidence detail/i);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    const blocks = container.querySelectorAll('.sre-skeleton');
    expect(blocks).toHaveLength(4);
    for (const block of blocks) expect(block.getAttribute('aria-hidden')).toBe('true');
  });

  test('responds to its own width instead of the page viewport', () => {
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

    const section = screen.getByRole('heading', { name: 'Evidence ledger' }).closest('section')!;
    const grid = screen.getByLabelText('Evidence records').parentElement!;
    expect(section.className).toContain('@container');
    expect(grid.className).toContain('@3xl:grid-cols-[18rem_minmax(0,1fr)]');
    expect(grid.className).not.toContain('lg:grid-cols');
    expect(screen.getByRole('heading', { name: 'Prometheus' }).className).toContain('break-words');
  });
});
