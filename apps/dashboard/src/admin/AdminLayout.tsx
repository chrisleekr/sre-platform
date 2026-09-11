import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { Layout } from '../components/Layout';
import type { PanelDef } from '../lib/types';

const ADMIN_PANELS: PanelDef[] = [
  { path: '/admin', label: 'Registrations', group: 'Configure' },
  { path: '/admin/workspaces', label: 'Workspaces', group: 'Configure' },
  { path: '/admin/users', label: 'Users', group: 'Configure' },
  { path: '/admin/providers', label: 'Identity providers', group: 'Configure' },
  { path: '/admin/settings', label: 'Platform settings', group: 'Configure' },
  { path: '/admin/audit', label: 'Audit trail', group: 'Configure' },
];

/** Connects the authenticated platform administrator to the shared responsive shell. */
export function AdminLayout() {
  const session = useSession();
  const navigate = useNavigate();
  return (
    <Layout
      panels={ADMIN_PANELS}
      user={session.user}
      workspaceLabel="Platform administration"
      onLogout={() => {
        session.logout();
        navigate('/', { replace: true });
      }}
    />
  );
}
