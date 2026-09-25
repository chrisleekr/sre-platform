// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { authenticatedFetch } from '../../../lib/authenticatedFetch';
import type { Incident } from '../../../lib/types';
import { useResolutionPolicy } from '../use-resolution-policy';

vi.mock('../../../lib/authenticatedFetch', () => ({ authenticatedFetch: vi.fn() }));

const getCredentials = async () => ({ kind: 'cookie' as const });
const incident: Incident = {
  id: '11111111-1111-4111-8111-111111111111',
  service: 'slack:C-OPERATIONS',
  severity: 'sev3',
  status: 'open',
  investigationStatus: 'assessed',
  lifecycleVersion: 3,
  alertSource: 'slack',
  rcaSummary: null,
  confidence: null,
  createdAt: '2026-09-10T01:00:00.000Z',
};

afterEach(cleanup);

function renderPolicy() {
  const clearReason = vi.fn<() => void>();
  const refreshWorkspace = vi.fn<() => void>();
  const hook = renderHook(() =>
    useResolutionPolicy(
      incident,
      'Provider clear is enough',
      clearReason,
      getCredentials,
      refreshWorkspace,
    ),
  );
  return { hook, clearReason, refreshWorkspace };
}

test('a saved policy change clears the shared reason and refreshes the workspace', async () => {
  vi.mocked(authenticatedFetch).mockReset().mockResolvedValueOnce(Response.json({}));
  const { hook, clearReason, refreshWorkspace } = renderPolicy();

  await act(() => hook.result.current.changeResolutionPolicy());

  expect(clearReason).toHaveBeenCalledTimes(1);
  expect(refreshWorkspace).toHaveBeenCalled();
  expect(hook.result.current.resolutionPolicyError).toBeNull();
});

test('a version conflict keeps the reason for the retry and refreshes the stale workspace', async () => {
  vi.mocked(authenticatedFetch)
    .mockReset()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }));
  const { hook, clearReason, refreshWorkspace } = renderPolicy();

  await act(() => hook.result.current.changeResolutionPolicy());

  expect(clearReason).not.toHaveBeenCalled();
  expect(refreshWorkspace).toHaveBeenCalled();
  expect(hook.result.current.resolutionPolicyError).toBe(
    'Incident state changed. Review it and try again.',
  );
});
