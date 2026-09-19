import { PageHeader } from './PageHeader';
import { StatePanel } from './PageState';
import { useNotificationInbox } from '../lib/notification-inbox';
import { Link } from 'react-router-dom';

function observedAt(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

/** Presents durable account and workspace events without mixing them into incident response. */
export function NotificationsPanel() {
  const inbox = useNotificationInbox();
  return (
    <section className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Notifications"
        description="Account, workspace, directory, and access changes that need your awareness."
        action={
          inbox.unreadCount > 0 ? (
            <button type="button" className="sre-action" onClick={() => void inbox.markAllRead()}>
              Mark all read
            </button>
          ) : undefined
        }
      />

      {inbox.loading && inbox.notifications.length === 0 && (
        <StatePanel state="loading" title="Loading notifications…" />
      )}
      {inbox.error && inbox.notifications.length === 0 && (
        <StatePanel
          state="error"
          title="Notifications are unavailable"
          description="Your inbox is durable. Retry when the API is available."
          onRetry={inbox.refresh}
        />
      )}
      {!inbox.loading && !inbox.error && inbox.notifications.length === 0 && (
        <StatePanel
          state="empty"
          title="You are all caught up"
          description="Workspace and account changes will appear here."
        />
      )}

      {inbox.error && inbox.notifications.length > 0 && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-critical-line bg-critical-soft p-3 text-sm text-critical"
        >
          {inbox.error}
        </p>
      )}

      {inbox.notifications.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <ul className="divide-y divide-line">
            {inbox.notifications.map((item) => (
              <li
                key={item.id}
                className={`relative p-4 sm:p-5 ${item.readAt ? '' : 'bg-accent-soft/40'}`}
              >
                {!item.readAt && (
                  <span
                    aria-label="Unread"
                    className="absolute left-0 top-5 h-8 w-1 rounded-r bg-accent"
                  />
                )}
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0">
                    <h2 className="text-base font-medium text-ink">{item.title}</h2>
                    <p className="mt-1 text-sm leading-6 text-ink-muted">{item.text}</p>
                    <p className="mt-2 text-xs text-ink-faint">{observedAt(item.createdAt)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-2">
                    <Link
                      to={item.href}
                      className="text-sm font-semibold text-accent hover:underline"
                      onClick={() => {
                        if (!item.readAt) void inbox.markRead(item.id);
                      }}
                    >
                      Open
                    </Link>
                    {!item.readAt && (
                      <button
                        type="button"
                        className="text-xs font-medium text-ink-muted hover:text-ink"
                        onClick={() => void inbox.markRead(item.id)}
                      >
                        Mark read
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {inbox.nextCursor && (
            <div className="border-t border-line p-4 text-center">
              <button
                type="button"
                disabled={inbox.loadingMore}
                className="sre-action"
                onClick={inbox.loadMore}
              >
                {inbox.loadingMore ? 'Loading…' : 'Load older'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
