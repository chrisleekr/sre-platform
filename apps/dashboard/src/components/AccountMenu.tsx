import { useState } from 'react';
import { Link } from 'react-router-dom';
import { productPath } from '../lib/routes';
import { ThemeControl } from './ThemeControl';

interface AccountMenuProps {
  user: { email?: string | null };
  workspace: {
    name: string;
    role: 'owner' | 'admin' | 'member';
    identityScope?: string;
  };
  onSignOut(): void;
  onSignOutEverywhere(): void | Promise<void>;
  unreadCount?: number;
  isPlatformAdmin?: boolean;
  pendingRegistrationCount?: number;
}

/** Shows account details and session actions without changing the authenticated workspace. */
export function AccountMenu({
  user,
  workspace,
  onSignOut,
  onSignOutEverywhere,
  unreadCount = 0,
  isPlatformAdmin = false,
  pendingRegistrationCount = 0,
}: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const role = workspace.role[0]!.toUpperCase() + workspace.role.slice(1);
  return (
    <div className="relative ml-auto shrink-0">
      <button
        type="button"
        aria-label={`Account menu${unreadCount ? `, ${unreadCount} unread notifications` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="sre-action sre-hit-target text-ink-muted"
      >
        <span aria-hidden="true">{user.email?.slice(0, 1).toUpperCase() ?? 'A'}</span>
        {unreadCount > 0 && (
          <span
            aria-hidden="true"
            className="absolute -right-1 -top-1 grid min-h-5 min-w-5 place-items-center rounded-full bg-critical-solid px-1 text-[0.65rem] font-bold text-on-strong"
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Account"
          className="absolute right-0 top-full z-40 mt-2 max-h-[calc(100dvh-6rem)] w-72 max-w-[calc(100vw-2rem)] overflow-y-auto overscroll-contain rounded-xl border border-line bg-surface p-4"
        >
          <p className="truncate text-sm font-semibold text-ink">{user.email ?? 'Signed in'}</p>
          <p className="mt-1 truncate text-sm text-ink-muted">{workspace.name}</p>
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {role}
          </p>
          {isPlatformAdmin && (
            <Link
              className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-accent"
              to="/admin"
              onClick={() => setOpen(false)}
            >
              <span>Platform administration</span>
              {pendingRegistrationCount > 0 && (
                <span className="rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
                  {pendingRegistrationCount}
                </span>
              )}
            </Link>
          )}
          {(workspace.role === 'owner' || workspace.role === 'admin') && (
            <Link
              className="mt-3 block text-sm font-semibold text-accent"
              to={productPath('settings/members')}
            >
              Manage members
            </Link>
          )}
          <Link
            to="/w/select?switch=true"
            onClick={() => setOpen(false)}
            className="mt-3 block text-sm font-semibold text-accent"
          >
            Switch workspace
          </Link>
          <Link
            className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-accent"
            to={productPath('notifications')}
            onClick={() => setOpen(false)}
          >
            <span>Notifications</span>
            {unreadCount > 0 && (
              <span className="rounded-full bg-critical-soft px-2 py-0.5 text-xs text-critical">
                {unreadCount}
              </span>
            )}
          </Link>
          <div className="mt-4 border-t border-line pt-4">
            <ThemeControl />
          </div>
          <div className="mt-4 grid gap-2 border-t border-line pt-4">
            <button
              type="button"
              className="rounded-md px-3 py-2 text-left text-sm hover:bg-surface-subtle"
              onClick={onSignOut}
            >
              Sign out
            </button>
            <button
              type="button"
              className="rounded-md px-3 py-2 text-left text-sm text-critical hover:bg-critical-soft"
              onClick={() => void onSignOutEverywhere()}
            >
              Sign out everywhere
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
