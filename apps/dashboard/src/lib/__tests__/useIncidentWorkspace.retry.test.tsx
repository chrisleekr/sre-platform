// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useIncidentWorkspace } from '../useIncidentWorkspace';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test('refreshes a failed run until its queued retry settles, then stops polling', async () => {
  vi.useFakeTimers();
  const state = (pending: boolean) => ({
    id: 'incident',
    latestInvestigationRun: { outcome: 'failed' },
    pendingAutomation: pending
      ? { type: 'triage', status: 'queued', scheduledAt: new Date().toISOString() }
      : null,
  });
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(state(true)))
    .mockResolvedValueOnce(Response.json(state(false)));
  vi.stubGlobal('fetch', fetch);
  const options = {
    apiBaseUrl: 'http://localhost:43000',
    getCredentials: async () => ({ kind: 'bearer' as const, token: 'test' }),
  };
  const { result, unmount } = renderHook(() => useIncidentWorkspace('incident', options));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.workspace?.incident.pendingAutomation).not.toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(result.current.workspace?.incident.pendingAutomation).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  unmount();
});
