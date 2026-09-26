import { Navigate, createBrowserRouter, useLocation, useParams } from 'react-router-dom';
import { RequireAuth, RequirePlatformAdmin, RequireWorkspace } from './auth';
import { AuthedLayout } from './components/AuthedLayout';
import { DashboardPanel } from './components/DashboardPanel';
import { IncidentsPanel } from './components/IncidentsPanel';
import { InfrastructurePanel } from './components/InfrastructurePanel';
import { DeploymentsPanel } from './components/DeploymentsPanel';
import { ChangesPanel } from './components/ChangesPanel';
import { TopologyPanel } from './components/TopologyPanel';
import { ConnectorsPanel } from './components/ConnectorsPanel';
import { InboundPanel } from './components/InboundPanel';
import { UsagePanel } from './components/UsagePanel';
import { WorkQueuePanel } from './components/WorkQueuePanel';
import { IncidentConversation } from './components/IncidentConversation';
import { PostmortemPage } from './components/PostmortemPage';
import { LoginPage } from './components/LoginPage';
import { ReliabilityPanel } from './components/ReliabilityPanel';
import { ErrorBudgetsPanel } from './components/ErrorBudgetsPanel';
import { SignalsPanel } from './components/SignalsPanel';
import { AuthCallback } from './components/AuthCallback';
import { MembersPage } from './components/MembersPanel';
import { LandingPage } from './onboarding/LandingPage';
import { WorkspaceSignInPage } from './onboarding/WorkspaceSignInPage';
import { WorkspaceChooserPage } from './onboarding/WorkspaceChooserPage';
import { WorkspaceSetupPage } from './onboarding/WorkspaceSetupPage';
import { VerifyDomainPage } from './onboarding/VerifyDomainPage';
import { VerifyEmailPage } from './onboarding/VerifyEmailPage';
import { NotificationsPanel } from './components/NotificationsPanel';
import { productPath } from './lib/routes';
import { AdminLayout } from './admin/AdminLayout';
import { RegistrationsPage } from './admin/RegistrationsPage';
import { WorkspacesPage } from './admin/WorkspacesPage';
import { UsersPage } from './admin/UsersPage';
import { ProvidersPage } from './admin/ProvidersPage';
import { PlatformSettingsPage } from './admin/PlatformSettingsPage';
import { AuditPage } from './admin/AuditPage';
import { WorkspaceSettingsPage } from './components/WorkspaceSettingsPage';
import { AuthenticationSettingsPage } from './components/AuthenticationSettingsPage';
import { WorkspaceDeletionPage } from './onboarding/WorkspaceDeletionPage';

function LegacyIncidentRedirect() {
  const { id = '' } = useParams();
  const location = useLocation();
  return (
    <Navigate
      to={`${productPath(`incidents/${encodeURIComponent(id)}`)}${location.search}${location.hash}`}
      replace
    />
  );
}

function LegacyPanelRedirect({ path }: { path: string }) {
  const location = useLocation();
  return <Navigate to={`${productPath(path)}${location.search}${location.hash}`} replace />;
}

function WorkspaceAccessPage({ title }: { title: string }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-canvas p-6 text-ink">
      <section className="max-w-lg rounded-xl border border-line bg-surface p-6">
        <h1 className="text-xl font-medium">{title}</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Contact your workspace administrator if you need help.
        </p>
      </section>
    </main>
  );
}

const legacyPanels = [
  'incidents',
  'signals',
  'infrastructure',
  'deployments',
  'changes',
  'topology',
  'reliability',
  'error-budgets',
  'connectors',
  'surfaces',
  'usage',
  'settings',
];

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/sign-in', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  { path: '/auth/callback', element: <AuthCallback /> },
  { path: '/auth/verify-email', element: <VerifyEmailPage /> },
  {
    path: '/w/select',
    element: (
      <RequireAuth>
        <WorkspaceChooserPage />
      </RequireAuth>
    ),
  },
  {
    path: '/get-started',
    children: [
      { index: true, element: <WorkspaceSetupPage /> },
      { path: '*', element: <Navigate to="/get-started" replace /> },
    ],
  },
  { path: '/welcome', element: <Navigate to="/w" replace /> },
  { path: '/workspace-suspended', element: <WorkspaceAccessPage title="Workspace suspended" /> },
  {
    path: '/workspace-deleting',
    element: (
      <RequireAuth>
        <WorkspaceDeletionPage />
      </RequireAuth>
    ),
  },
  { path: '/workspace-removed', element: <WorkspaceAccessPage title="Access removed" /> },
  {
    path: '/workspace-directory-unverified',
    element: <WorkspaceAccessPage title="Email domain not verified" />,
  },
  {
    path: '/workspace-directory-required',
    element: <WorkspaceAccessPage title="Sign in with your workspace directory" />,
  },
  {
    path: '/w',
    element: (
      <RequireWorkspace>
        <AuthedLayout />
      </RequireWorkspace>
    ),
    children: [
      { index: true, element: <DashboardPanel /> },
      { path: 'incidents', element: <IncidentsPanel /> },
      { path: 'signals', element: <SignalsPanel /> },
      { path: 'infrastructure', element: <InfrastructurePanel /> },
      { path: 'deployments', element: <DeploymentsPanel /> },
      { path: 'changes', element: <ChangesPanel /> },
      { path: 'topology', element: <TopologyPanel /> },
      { path: 'reliability', element: <ReliabilityPanel /> },
      { path: 'reliability/weekly', element: <ReliabilityPanel mode="weekly" /> },
      { path: 'error-budgets', element: <ErrorBudgetsPanel /> },
      { path: 'connectors', element: <ConnectorsPanel /> },
      { path: 'surfaces', element: <InboundPanel /> },
      { path: 'usage', element: <UsagePanel /> },
      { path: 'work-queue', element: <WorkQueuePanel /> },
      { path: 'settings', element: <Navigate to="/w/settings/workspace" replace /> },
      { path: 'settings/workspace', element: <WorkspaceSettingsPage /> },
      { path: 'settings/authentication', element: <AuthenticationSettingsPage /> },
      { path: 'settings/members', element: <MembersPage /> },
      { path: 'settings/domains/:id', element: <VerifyDomainPage /> },
      { path: 'notifications', element: <NotificationsPanel /> },
      { path: 'incidents/:id', element: <IncidentConversation /> },
      { path: 'incidents/:id/postmortem', element: <PostmortemPage /> },
    ],
  },
  {
    path: '/admin',
    element: (
      <RequirePlatformAdmin>
        <AdminLayout />
      </RequirePlatformAdmin>
    ),
    children: [
      { index: true, element: <RegistrationsPage /> },
      { path: 'workspaces', element: <WorkspacesPage /> },
      { path: 'users', element: <UsersPage /> },
      { path: 'providers', element: <ProvidersPage /> },
      { path: 'settings', element: <PlatformSettingsPage /> },
      { path: 'audit', element: <AuditPage /> },
    ],
  },
  { path: '/incidents/:id', element: <LegacyIncidentRedirect /> },
  { path: '/reliability/weekly', element: <LegacyPanelRedirect path="reliability/weekly" /> },
  ...legacyPanels.map((path) => ({
    path: `/${path}`,
    element: <LegacyPanelRedirect path={path} />,
  })),
  { path: '/:slug', element: <WorkspaceSignInPage /> },
]);
