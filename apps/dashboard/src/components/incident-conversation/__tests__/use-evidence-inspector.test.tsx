// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useEvidenceInspector } from '../use-evidence-inspector';

const first = '22222222-2222-4222-8222-000000000001';
const second = '22222222-2222-4222-8222-000000000002';

afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

test('closing a pushed inspector session leaves one history step, not a dead entry', async () => {
  window.history.replaceState(null, '', '/incidents/one');
  const start = window.history.length;
  const hook = renderHook(() => useEvidenceInspector('one', vi.fn()));

  act(() => hook.result.current.openEvidence(first));
  act(() => hook.result.current.openEvidence(second));
  expect(window.history.length).toBe(start + 1);
  expect(window.location.hash).toBe(`#evidence-${second}`);

  act(() => hook.result.current.closeEvidence());
  await waitFor(() => expect(window.location.hash).toBe(''));
  expect(hook.result.current.inspectorOpen).toBe(false);

  // Forward returns to the inspector entry, proving Close stepped back instead of adding a dead entry.
  act(() => window.history.forward());
  await waitFor(() => expect(hook.result.current.inspectorId).toBe(second));
});

test('closing a deep-linked inspector rewrites the entry instead of leaving the page', async () => {
  window.history.replaceState(null, '', `/incidents/one#evidence-${first}`);
  const hook = renderHook(() => useEvidenceInspector('one', vi.fn()));
  expect(hook.result.current.inspectorId).toBe(first);

  act(() => hook.result.current.openEvidence(second));
  act(() => hook.result.current.closeEvidence());

  expect(window.location.pathname).toBe('/incidents/one');
  expect(window.location.hash).toBe('');
  expect(hook.result.current.inspectorOpen).toBe(false);
});

test('an inspector effect that runs after All evidence leaves the list open', () => {
  window.history.replaceState(null, '', '/incidents/one');
  const hook = renderHook(({ loadDetail }) => useEvidenceInspector('one', loadDetail), {
    initialProps: { loadDetail: vi.fn() },
  });
  act(() => hook.result.current.showAllEvidence());
  // A new loadDetail re-runs the effect, as a mount effect does when React flushes it after a click.
  hook.rerender({ loadDetail: vi.fn() });
  expect(hook.result.current.inspectorOpen).toBe(true);
  expect(hook.result.current.inspectorId).toBeNull();
});
