// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DeploymentOverview } from '../DeploymentOverview';

test('shows operational counts, evidence gaps, and applies responder filters', () => {
  const onApplySearch = vi.fn();
  const onSearchDraftChange = vi.fn();
  const onRangeChange = vi.fn();
  const onSourceChange = vi.fn();
  const onStatusChange = vi.fn();
  const onClear = vi.fn();
  render(
    <DeploymentOverview
      summary={{
        total: 65,
        failed: 2,
        active: 3,
        environmentMissing: 65,
        latestAt: '2026-08-23T01:02:03Z',
      }}
      range="24h"
      searchDraft="checkout"
      source="argocd"
      status="failed"
      applicationCount={10}
      applicationAttentionCount={1}
      relatedIncidentCount={2}
      gitOpsObservedAt={null}
      gitOpsStale={false}
      onRangeChange={onRangeChange}
      onSearchDraftChange={onSearchDraftChange}
      onSourceChange={onSourceChange}
      onStatusChange={onStatusChange}
      onApplySearch={onApplySearch}
      onClear={onClear}
    />,
  );

  expect(screen.getByText('need attention of 10 observed')).toBeDefined();
  expect(screen.getByText(/Environment evidence is unavailable for 65 of 65/)).toBeDefined();
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'orders' } });
  expect(onSearchDraftChange).toHaveBeenCalledWith('orders');
  fireEvent.submit(screen.getByRole('searchbox').closest('form')!);
  expect(onApplySearch).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(onClear).toHaveBeenCalledOnce();
});
