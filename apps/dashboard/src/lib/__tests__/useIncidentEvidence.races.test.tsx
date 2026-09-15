// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useIncidentEvidence } from '../useIncidentEvidence';

const originalFetch = globalThis.fetch;
const opts = {
  apiBaseUrl: 'http://fixture',
  getCredentials: async () => ({ kind: 'bearer' as const, token: 'fixture' }),
};
const item = {
  id: 'check',
  tool: 'query',
  outcome: 'data',
  latencyMs: 1,
  recordedAt: '2026-09-14T00:00:00Z',
  hasOutput: true,
};
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
function deferred() {
  let resolve!: (value: Response) => void;
  return {
    promise: new Promise<Response>((done) => {
      resolve = done;
    }),
    resolve: (value: Response) => resolve(value),
  };
}
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

test('deduplicates simultaneous detail opens and rejects a former incident response', async () => {
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).endsWith('/evidence/check')) {
      calls++;
      return pending.promise;
    }
    return response({ evidence: [], nextCursor: null });
  });
  const hook = renderHook(({ id }) => useIncidentEvidence(id, opts), {
    initialProps: { id: 'first' },
  });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  act(() => {
    hook.result.current.loadDetail('check');
    hook.result.current.loadDetail('check');
  });
  await waitFor(() => expect(calls).toBe(1));
  hook.rerender({ id: 'second' });
  await act(async () => pending.resolve(response({ ...item, output: 'former incident' })));
  expect(hook.result.current.details).toEqual({});
});
test('serializes older requests and does not append duplicates', async () => {
  const pending = deferred();
  let calls = 0;
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('before=')) {
      calls++;
      return pending.promise;
    }
    return response({ evidence: [item], nextCursor: 'older' });
  });
  const hook = renderHook(() => useIncidentEvidence('first', opts));
  await waitFor(() => expect(hook.result.current.evidence).toHaveLength(1));
  act(() => {
    hook.result.current.loadOlder();
    hook.result.current.loadOlder();
  });
  await waitFor(() => expect(calls).toBe(1));
  await act(async () =>
    pending.resolve(
      response({
        evidence: [item, { ...item, id: 'older', recordedAt: '2026-09-13T23:59:59Z' }],
        nextCursor: null,
      }),
    ),
  );
  expect(hook.result.current.evidence.map((row) => row.id)).toEqual(['check', 'older']);
});
test('a failed background refresh retains previously loaded records', async () => {
  let fail = false;
  globalThis.fetch = vi.fn(async () =>
    fail
      ? new Response('Unavailable', { status: 503 })
      : response({ evidence: [item], nextCursor: null }),
  );
  const hook = renderHook(() => useIncidentEvidence('first', opts));
  await waitFor(() => expect(hook.result.current.evidence).toHaveLength(1));
  fail = true;
  act(() => hook.result.current.refresh());
  await waitFor(() => expect(hook.result.current.error).toBe(true));
  expect(hook.result.current.evidence).toEqual([item]);
});

test('refresh keeps new evidence reachable after pagination was exhausted', async () => {
  const rows = (newest: number, oldest: number) =>
    Array.from({ length: newest - oldest + 1 }, (_, offset) => {
      const value = newest - offset;
      return {
        ...item,
        id: String(value).padStart(3, '0'),
        recordedAt: new Date(Date.UTC(2026, 8, 14, 0, 0, value)).toISOString(),
      };
    });
  let refreshed = false;
  globalThis.fetch = vi.fn(async (url) => {
    const before = new URL(String(url)).searchParams.get('before');
    if (before === '021') return response({ evidence: rows(20, 1), nextCursor: null });
    if (before === '046') return response({ evidence: rows(45, 26), nextCursor: '026' });
    return response({
      evidence: refreshed ? rows(65, 46) : rows(40, 21),
      nextCursor: refreshed ? '046' : '021',
    });
  });
  const hook = renderHook(() => useIncidentEvidence('first', opts));
  await waitFor(() => expect(hook.result.current.evidence).toHaveLength(20));
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(hook.result.current.nextCursor).toBeNull());
  expect(hook.result.current.evidence).toHaveLength(40);

  refreshed = true;
  act(() => hook.result.current.refresh());
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  expect(hook.result.current.evidence).toHaveLength(60);
  expect(hook.result.current.nextCursor).toBe('046');
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(hook.result.current.evidence).toHaveLength(65));
  expect(hook.result.current.evidence.map((row) => row.id)).toEqual(
    rows(65, 1).map((row) => row.id),
  );
});

test('does not start an older page while the refreshed head is pending', async () => {
  const head = deferred();
  const older = vi.fn(async () => response({ evidence: [], nextCursor: null }));
  let refreshing = false;
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).includes('before=')) return older();
    return refreshing ? head.promise : response({ evidence: [item], nextCursor: 'old-cursor' });
  });
  const hook = renderHook(() => useIncidentEvidence('first', opts));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  refreshing = true;
  act(() => hook.result.current.refresh());
  act(() => hook.result.current.loadOlder());
  await act(async () =>
    head.resolve(response({ evidence: [item], nextCursor: 'refreshed-cursor' })),
  );
  expect(older).not.toHaveBeenCalled();
  expect(hook.result.current.nextCursor).toBe('refreshed-cursor');
  act(() => hook.result.current.loadOlder());
  await waitFor(() => expect(older).toHaveBeenCalledOnce());
  expect(globalThis.fetch).toHaveBeenLastCalledWith(
    expect.stringContaining('before=refreshed-cursor'),
    expect.anything(),
  );
});
