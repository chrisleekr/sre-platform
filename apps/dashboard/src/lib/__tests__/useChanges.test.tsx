// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useChanges } from '../useChanges';

const originalFetch = globalThis.fetch;
const getCredentials = async () => ({ kind: 'bearer' as const, token: 'jwt' });

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('useChanges', () => {
  test('encodes pagination and every evidence filter into the authenticated request', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        changes: [],
        nextCursor: null,
        summary: { total: 0, failing: 0, succeeded: 0, latestAt: null },
        sources: [],
      }),
    );

    const { result } = renderHook(() =>
      useChanges({
        apiBaseUrl: 'http://api',
        getCredentials,
        cursor: 'next page',
        limit: 25,
        filters: {
          provider: 'github',
          category: 'ci',
          repository: 'acme/checkout',
          search: 'failed deploy',
          from: '2026-08-24T00:00:00Z',
          to: '2026-08-25T00:00:00Z',
          status: 'failed',
          dataSourceId: '00000000-0000-4000-8000-000000000001',
        },
      }),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'http://api/changes?cursor=next+page&limit=25&provider=github&category=ci&repository=acme%2Fcheckout&search=failed+deploy&from=2026-08-24T00%3A00%3A00Z&to=2026-08-25T00%3A00%3A00Z&status=failed&dataSourceId=00000000-0000-4000-8000-000000000001',
      { credentials: 'include', headers: { authorization: 'Bearer jwt', 'x-sre-session': '1' } },
    );
  });
});
