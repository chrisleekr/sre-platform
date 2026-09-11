// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitOps } from '../useGitOps';

const originalFetch = globalThis.fetch;
const getCredentials = async () => ({ kind: 'bearer' as const, token: 'jwt' });
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useGitOps', () => {
  test('loads the authenticated tenant live-application projection', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        applications: [
          {
            source: 'argocd',
            entityId: 'application:payments/argocd/checkout',
            applicationId: 'payments/argocd/checkout',
            applicationName: 'checkout',
            applicationNamespace: 'argocd',
            project: 'payments',
            revisions: ['head'],
            conditions: [],
            observedAt: '2026-08-22T01:00:00Z',
          },
        ],
      }),
    );
    const { result } = renderHook(() => useGitOps({ apiBaseUrl: 'http://api', getCredentials }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.applications[0]?.applicationName).toBe('checkout');
    expect(globalThis.fetch).toHaveBeenCalledWith('http://api/gitops', {
      headers: { authorization: 'Bearer jwt', 'x-sre-session': '1' },
      credentials: 'include',
    });
  });
});
