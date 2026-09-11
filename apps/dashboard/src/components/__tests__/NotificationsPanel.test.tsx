// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { NotificationInboxProvider } from '../../lib/notification-inbox';
import { NotificationsPanel } from '../NotificationsPanel';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('NotificationsPanel', () => {
  test('shows unread events and marks all of the recipient rows read', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ marked: 1 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          notifications: [
            {
              id: '7a6a355c-69b7-4dcc-9928-ea670d9e83a8',
              kind: 'directory.verified',
              payload: { domain: 'example.test' },
              createdAt: '2026-09-05T01:00:00.000Z',
              readAt: null,
              title: 'Directory domain verified',
              text: 'example.test is verified.',
              href: 'https://sre.example.test/w/settings',
            },
          ],
          unreadCount: 1,
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter>
        <NotificationInboxProvider
          getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
          sessionKey="session-a"
        >
          <NotificationsPanel />
        </NotificationInboxProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Directory domain verified' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Mark all read' })).toBeNull());
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/me/notifications/read-all'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  test('keeps the unread row and reports a failed read mutation', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Response(null, { status: 503 });
      return new Response(
        JSON.stringify({
          notifications: [
            {
              id: '7a6a355c-69b7-4dcc-9928-ea670d9e83a8',
              kind: 'directory.verified',
              payload: {},
              createdAt: '2026-09-05T01:00:00.000Z',
              readAt: null,
              title: 'Directory domain verified',
              text: 'example.test is verified.',
              href: 'https://sre.example.test/w',
            },
          ],
          unreadCount: 1,
          nextCursor: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter>
        <NotificationInboxProvider
          getCredentials={async () => ({ kind: 'bearer' as const, token: 'token' })}
          sessionKey="session-a"
        >
          <NotificationsPanel />
        </NotificationInboxProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Directory domain verified' });
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The notification could not be marked read.',
    );
    expect(screen.getByRole('button', { name: 'Mark read' })).toBeDefined();
  });
});
