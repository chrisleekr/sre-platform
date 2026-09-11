// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { NotificationInboxProvider, useNotificationInbox } from '../notification-inbox';

function Probe() {
  const inbox = useNotificationInbox();
  return <p>{inbox.loading ? 'loading' : `${inbox.unreadCount} unread`}</p>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('notification inbox polling', () => {
  test('loads immediately, on focus, and every sixty seconds', async () => {
    let intervalTick: (() => void) | undefined;
    const nativeSetInterval = window.setInterval.bind(window);
    vi.spyOn(window, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      if (timeout === 60_000) {
        intervalTick = handler as () => void;
        return 1 as unknown as ReturnType<typeof window.setInterval>;
      }
      return nativeSetInterval(handler, timeout);
    }) as typeof window.setInterval);
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ notifications: [], unreadCount: 2, nextCursor: null }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(
      <NotificationInboxProvider
        getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
        sessionKey="session-a"
      >
        <Probe />
      </NotificationInboxProvider>,
    );
    await waitFor(() => expect(screen.getByText('2 unread')).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await act(async () => intervalTick?.());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  });
});
