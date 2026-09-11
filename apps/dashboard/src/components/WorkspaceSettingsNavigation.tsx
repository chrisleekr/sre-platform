import { NavLink } from 'react-router-dom';

const tabs = [
  { to: '/w/settings/workspace', label: 'Workspace' },
  { to: '/w/settings/authentication', label: 'Authentication' },
  { to: '/w/settings/members', label: 'Members' },
] as const;

/** Settings-area navigation shared by workspace administration pages. */
export function WorkspaceSettingsNavigation() {
  return (
    <nav aria-label="Workspace settings" className="mb-5 overflow-x-auto border-b border-line">
      <div className="flex min-w-max gap-1">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              `border-b-2 px-3 py-2.5 text-sm font-semibold ${isActive ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink'}`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
