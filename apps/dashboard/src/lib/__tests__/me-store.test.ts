// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  clearRememberedWorkspace,
  invalidateMe,
  loadMe,
  nextWorkspaceRoute,
  resetMeStoreForTests,
} from '../me-store';

const ACTIVE = {
  user: { id: 'user-1', email: 'person@example.test', isPlatformAdmin: false },
  state: 'active' as const,
  tenant: {
    id: 'tenant-1',
    name: 'Acme Engineering',
    slug: 'acme',
    status: 'active',
    role: 'owner' as const,
    founderOnly: false,
  },
  founding: null,
  workspaces: [],
  welcome: { complete: false, shown: false, dismissed: false },
};

afterEach(() => {
  resetMeStoreForTests();
  vi.restoreAllMocks();
});

describe('current-user workspace store', () => {
  test('deduplicates one current-user load until explicitly invalidated', async () => {
    const fetcher = vi.fn(async () => ACTIVE);
    const first = loadMe(fetcher, 'session-a');
    const second = loadMe(fetcher, 'session-a');

    expect(first).toBe(second);
    await expect(first).resolves.toEqual(ACTIVE);
    expect(fetcher).toHaveBeenCalledOnce();

    invalidateMe();
    await expect(loadMe(fetcher, 'session-a')).resolves.toEqual(ACTIVE);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('does not reuse one identity projection for a replacement session', async () => {
    const first = vi.fn(async () => ACTIVE);
    const secondValue = {
      ...ACTIVE,
      user: { ...ACTIVE.user, id: 'user-2', email: 'other@example.test' },
    };
    await loadMe(first, 'session-a');

    await expect(
      loadMe(
        vi.fn(async () => secondValue),
        'session-b',
      ),
    ).resolves.toEqual(secondValue);
    expect(first).toHaveBeenCalledOnce();
  });

  test('does not persist workspace metadata during identity loading', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    await expect(loadMe(async () => ACTIVE, 'session-a')).resolves.toEqual(ACTIVE);
    await expect(loadMe(vi.fn(), 'session-a')).resolves.toEqual(ACTIVE);
    expect(write).not.toHaveBeenCalled();
  });

  test('clears remembered-workspace storage on a best-effort basis', () => {
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage disabled', 'SecurityError');
    });

    expect(() => clearRememberedWorkspace()).not.toThrow();
  });

  test('ignores a late response from the session it replaced', async () => {
    let resolveFirst!: (value: typeof ACTIVE) => void;
    const first = loadMe(
      () => new Promise<typeof ACTIVE>((resolve) => (resolveFirst = resolve)),
      'session-a',
    );
    const secondValue = {
      ...ACTIVE,
      user: { ...ACTIVE.user, id: 'user-2', email: 'other@example.test' },
    };
    await loadMe(async () => secondValue, 'session-b');
    resolveFirst(ACTIVE);
    await first;

    await expect(
      loadMe(
        vi.fn(async () => ACTIVE),
        'session-b',
      ),
    ).resolves.toEqual(secondValue);
  });

  test('refetches after the one-time welcome mutation and routes subsequent visits home', async () => {
    const firstVisit = await loadMe(async () => ACTIVE, 'session-a');
    expect(nextWorkspaceRoute(firstVisit)).toBe('/w');

    invalidateMe('session-a');
    const afterShown = await loadMe(
      async () => ({
        ...ACTIVE,
        welcome: { complete: false, shown: true, dismissed: false },
      }),
      'session-a',
    );
    expect(nextWorkspaceRoute(afterShown)).toBe('/w');
  });

  test('routes active, founding, unaffiliated, suspended, and removed states without loops', () => {
    expect(nextWorkspaceRoute(ACTIVE)).toBe('/w');
    expect(
      nextWorkspaceRoute({
        ...ACTIVE,
        welcome: { complete: false, shown: true, dismissed: false },
      }),
    ).toBe('/w');
    expect(
      nextWorkspaceRoute({
        ...ACTIVE,
        welcome: { complete: true, shown: false, dismissed: false },
      }),
    ).toBe('/w');
    expect(
      nextWorkspaceRoute({
        ...ACTIVE,
        state: 'founding',
        tenant: null,
        founding: { id: 'founding-1', status: 'founder_authenticated' },
      }),
    ).toBe('/get-started');
    for (const status of ['pending', 'approved', 'provisioning', 'failed'] as const) {
      expect(
        nextWorkspaceRoute({
          ...ACTIVE,
          state: 'founding',
          tenant: null,
          founding: { id: 'founding-1', status },
        }),
      ).toBe('/get-started');
    }
    expect(nextWorkspaceRoute({ ...ACTIVE, state: 'unaffiliated', tenant: null })).toBe(
      '/get-started',
    );
    expect(nextWorkspaceRoute({ ...ACTIVE, state: 'suspended', tenant: null })).toBe(
      '/workspace-suspended',
    );
    expect(nextWorkspaceRoute({ ...ACTIVE, state: 'removed', tenant: null })).toBe(
      '/workspace-removed',
    );
  });
});
