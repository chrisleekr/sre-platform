import { checkResponse, requestErrorMessage } from './request-error';
import type { CredentialGetter } from './request-credentials';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { config } from '../config';
import { authenticatedFetch } from './authenticatedFetch';

export interface InboxNotification {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
  title: string;
  text: string;
  href: string;
}

interface InboxPage {
  notifications: InboxNotification[];
  unreadCount: number;
  nextCursor: string | null;
}

export interface NotificationInboxState {
  notifications: InboxNotification[];
  unreadCount: number;
  nextCursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  refresh(): void;
  loadMore(): void;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

const NotificationInboxContext = createContext<NotificationInboxState | null>(null);

async function authorizedRequest(
  getCredentials: CredentialGetter,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  return authenticatedFetch(`${config.apiBaseUrl}${path}`, getCredentials, {
    ...init,
    headers: init?.headers as Record<string, string> | undefined,
  });
}

/** Shares one polled inbox between the account badge and routed notifications panel. */
export function NotificationInboxProvider({
  getCredentials,
  sessionKey,
  children,
}: {
  getCredentials: CredentialGetter;
  sessionKey: string;
  children: ReactNode;
}) {
  const tokenRef = useRef(getCredentials);
  tokenRef.current = getCredentials;
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestVersion = useRef(0);

  const load = useCallback(async (after?: string) => {
    const version = ++requestVersion.current;
    if (after) setLoadingMore(true);
    else setLoading(true);
    try {
      const query = after ? `?after=${encodeURIComponent(after)}` : '';
      const response = await authorizedRequest(tokenRef.current, `/me/notifications${query}`);
      await checkResponse(response, `notification inbox failed with ${response.status}`);
      const page = (await response.json()) as InboxPage;
      if (version !== requestVersion.current) return;
      setNotifications((current) =>
        after ? [...current, ...page.notifications] : page.notifications,
      );
      setUnreadCount(page.unreadCount);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch {
      if (version === requestVersion.current)
        setError('Notifications are temporarily unavailable.');
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    setNotifications([]);
    setUnreadCount(0);
    setNextCursor(null);
    setError(null);
    void load();
    const interval = window.setInterval(() => void load(), 60_000);
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      requestVersion.current += 1;
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [load, sessionKey]);

  const markRead = useCallback(async (id: string) => {
    try {
      const response = await authorizedRequest(tokenRef.current, `/me/notifications/${id}/read`, {
        method: 'POST',
      });
      await checkResponse(response, 'The notification could not be marked read.');
      setNotifications((current) =>
        current.map((item) =>
          item.id === id && !item.readAt ? { ...item, readAt: new Date().toISOString() } : item,
        ),
      );
      setUnreadCount((count) => Math.max(0, count - 1));
      setError(null);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'The notification could not be marked read.'));
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      const response = await authorizedRequest(tokenRef.current, '/me/notifications/read-all', {
        method: 'POST',
      });
      await checkResponse(response, 'Notifications could not be marked read.');
      const now = new Date().toISOString();
      setNotifications((current) =>
        current.map((item) => ({ ...item, readAt: item.readAt ?? now })),
      );
      setUnreadCount(0);
      setError(null);
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Notifications could not be marked read.'));
    }
  }, []);

  return (
    <NotificationInboxContext.Provider
      value={{
        notifications,
        unreadCount,
        nextCursor,
        loading,
        loadingMore,
        error,
        refresh: () => void load(),
        loadMore: () => {
          if (nextCursor && !loadingMore) void load(nextCursor);
        },
        markRead,
        markAllRead,
      }}
    >
      {children}
    </NotificationInboxContext.Provider>
  );
}

/** Returns the authenticated inbox shared by the app shell. */
export function useNotificationInbox(): NotificationInboxState {
  const value = useContext(NotificationInboxContext);
  if (!value) throw new Error('NotificationInboxProvider is required');
  return value;
}
