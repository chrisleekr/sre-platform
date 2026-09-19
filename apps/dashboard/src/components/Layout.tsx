import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { PanelDef } from '../lib/types';
import { useDocumentTitle } from '../lib/useDocumentTitle';
import { ThemeControl } from './ThemeControl';
import { AccountMenu } from './AccountMenu';

export interface LayoutProps {
  panels: PanelDef[];
  user?: { name?: string; email?: string };
  onLogout?: () => void;
  onLogoutEverywhere?: () => void | Promise<void>;
  workspace?: { name: string; role: 'owner' | 'admin' | 'member' };
  unreadNotificationCount?: number;
  isPlatformAdmin?: boolean;
  pendingRegistrationCount?: number;
  workspaceLabel?: string;
  banner?: ReactNode;
}

const NAV_GROUPS: PanelDef['group'][] = ['Respond', 'Observe', 'Configure'];

function PanelNavigation({
  panels,
  label,
  firstLinkRef,
  onNavigate,
}: {
  panels: PanelDef[];
  label: string;
  firstLinkRef?: RefObject<HTMLAnchorElement | null>;
  onNavigate?: () => void;
}) {
  let linkIndex = 0;
  const labelId = label.toLowerCase().replaceAll(' ', '-');
  return (
    <nav aria-label={label} className="flex min-h-0 flex-col gap-5 overflow-y-auto px-3 py-4">
      {NAV_GROUPS.map((group) => {
        const items = panels.filter((panel) => panel.group === group);
        if (items.length === 0) return null;
        return (
          <section key={group} aria-labelledby={`nav-${labelId}-${group.toLowerCase()}`}>
            <h2
              id={`nav-${labelId}-${group.toLowerCase()}`}
              className="mb-1 px-3 text-xs font-medium text-ink-muted"
            >
              {group}
            </h2>
            <div className="flex flex-col gap-0.5">
              {items.map((panel) => {
                const currentIndex = linkIndex++;
                return (
                  <NavLink
                    key={panel.path}
                    ref={currentIndex === 0 ? firstLinkRef : undefined}
                    to={panel.path}
                    end={panel.path === '/w' || panel.path === '/admin'}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      `sre-hit-target group relative flex items-center rounded-md px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
                        isActive
                          ? 'bg-accent-soft text-accent'
                          : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                      }`
                    }
                  >
                    {panel.label}
                  </NavLink>
                );
              })}
            </div>
          </section>
        );
      })}
    </nav>
  );
}

/** Presentational app shell: responsive panel navigation plus the routed panel body. */
export function Layout({
  panels,
  user,
  onLogout,
  onLogoutEverywhere,
  workspace,
  unreadNotificationCount = 0,
  isPlatformAdmin = false,
  pendingRegistrationCount = 0,
  workspaceLabel = 'Responder workspace',
  banner,
}: LayoutProps) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const firstDrawerLinkRef = useRef<HTMLAnchorElement>(null);
  const identity = user?.name ?? user?.email ?? 'Signed in';
  const location = useLocation();
  const panelTitle =
    panels.find((panel) => panel.path === location.pathname)?.label ??
    (location.pathname.startsWith('/w/incidents/') ? 'Incident' : null);
  useDocumentTitle(panelTitle);

  useEffect(() => {
    if (drawerOpen) firstDrawerLinkRef.current?.focus();
  }, [drawerOpen]);

  function closeDrawer(restoreFocus = false) {
    setDrawerOpen(false);
    if (restoreFocus) drawerTriggerRef.current?.focus();
  }

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeDrawer(true);
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = drawerRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), a[href]',
    );
    if (!focusable?.length) return;
    const first = focusable.item(0);
    const last = focusable.item(focusable.length - 1);

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="fixed inset-0 flex min-w-0 overflow-hidden bg-canvas text-ink">
      <a
        href="#main-content"
        className="sre-action sre-action-primary fixed left-3 top-3 z-[60] -translate-y-20 bg-surface focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex items-center gap-3 border-b border-line px-5 py-4">
          <span className="grid size-9 place-items-center rounded-lg bg-strong font-instrument text-xs font-bold tracking-wider text-on-strong">
            SRE
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-bold tracking-tight">SRE Platform</p>
            <p className="truncate text-xs text-ink-muted">{workspaceLabel}</p>
          </div>
        </div>
        <PanelNavigation panels={panels} label="Primary navigation" />
        <div className="mt-auto border-t border-line px-3 py-2">
          <ThemeControl />
        </div>
      </aside>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex min-w-0 items-center gap-3 border-b border-line bg-surface px-4 py-3 sm:px-5">
          <button
            ref={drawerTriggerRef}
            type="button"
            aria-label="Open navigation"
            aria-controls="compact-navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
            className="sre-hit-target grid shrink-0 place-items-center rounded-md p-1.5 text-ink-muted hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus lg:hidden"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <span className="hidden min-w-0 flex-1 truncate text-sm font-medium text-ink-muted lg:block">
            {panelTitle ?? 'Responder workspace'}
          </span>
          {workspace && onLogout && onLogoutEverywhere ? (
            <AccountMenu
              user={{ email: user?.email ?? user?.name }}
              workspace={workspace}
              onSignOut={onLogout}
              onSignOutEverywhere={onLogoutEverywhere}
              unreadCount={unreadNotificationCount}
              isPlatformAdmin={isPlatformAdmin}
              pendingRegistrationCount={pendingRegistrationCount}
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm text-ink-muted lg:flex-none">
              {identity}
            </span>
          )}
          {!workspace && onLogout && (
            <button
              type="button"
              onClick={onLogout}
              className="sre-hit-target shrink-0 rounded-md px-3 py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              Log out
            </button>
          )}
        </header>
        {banner}
        <main
          id="main-content"
          tabIndex={-1}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-5 xl:p-6"
        >
          <Outlet />
        </main>
      </div>
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-scrim backdrop-blur-[1px]"
            onClick={() => closeDrawer()}
          />
          <aside
            ref={drawerRef}
            id="compact-navigation"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            onKeyDown={handleDrawerKeyDown}
            className="relative flex h-dvh w-72 max-w-[calc(100vw-2.5rem)] flex-col overflow-y-auto overscroll-contain border-r border-line bg-surface"
          >
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <div>
                <span className="text-sm font-bold tracking-tight">SRE Platform</span>
                <p className="text-xs text-ink-muted">{workspaceLabel}</p>
              </div>
              <button
                type="button"
                aria-label="Close navigation"
                onClick={() => closeDrawer(true)}
                className="sre-hit-target grid place-items-center rounded-md p-1.5 text-ink-muted hover:bg-surface-subtle hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none">
                  <path
                    d="m6 6 12 12M18 6 6 18"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <PanelNavigation
              panels={panels}
              label="Compact navigation"
              firstLinkRef={firstDrawerLinkRef}
              onNavigate={() => closeDrawer()}
            />
            <div className="mt-auto border-t border-line px-3 py-2">
              <ThemeControl />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
