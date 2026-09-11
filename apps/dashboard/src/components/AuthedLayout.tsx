import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { RequireAuth, useSession } from '../auth';
import { takeReturnTo } from '../local-session';
import { PANELS } from '../lib/panels';
import { useMe } from '../lib/me-store';
import { Layout } from './Layout';
import { NotificationInboxProvider, useNotificationInbox } from '../lib/notification-inbox';
import { ImpersonationBanner } from './ImpersonationBanner';

function ConnectedLayout({
  user,
  onLogout,
  onLogoutEverywhere,
  workspace,
  isPlatformAdmin,
  pendingRegistrationCount,
}: {
  user: { name?: string; email?: string } | undefined;
  onLogout(): void;
  onLogoutEverywhere(): Promise<void>;
  workspace: { name: string; role: 'owner' | 'admin' | 'member' } | undefined;
  isPlatformAdmin: boolean;
  pendingRegistrationCount: number;
}) {
  const inbox = useNotificationInbox();
  return (
    <Layout
      panels={PANELS}
      user={user}
      onLogout={onLogout}
      onLogoutEverywhere={onLogoutEverywhere}
      workspace={workspace}
      unreadNotificationCount={inbox.unreadCount}
      isPlatformAdmin={isPlatformAdmin}
      pendingRegistrationCount={pendingRegistrationCount}
      banner={<ImpersonationBanner />}
    />
  );
}

/** Connects the session to the presentational Layout, behind the auth gate. */
export function AuthedLayout() {
  const session = useSession();
  const { status, user, logout, signOutEverywhere } = session;
  const me = useMe(session.getCredentials, status === 'authenticated', session.sessionKey);
  const navigate = useNavigate();

  // Recover a destination left behind when a sign-in flow did not complete through the callback page.
  useEffect(() => {
    if (status !== 'authenticated') return;
    const returnTo = takeReturnTo();
    if (returnTo) navigate(returnTo, { replace: true });
  }, [status, navigate]);

  return (
    <RequireAuth>
      {status === 'authenticated' && session.sessionKey ? (
        <NotificationInboxProvider
          getCredentials={session.getCredentials}
          sessionKey={session.sessionKey}
        >
          <ConnectedLayout
            user={user}
            onLogout={() => {
              logout();
              navigate('/', { replace: true });
            }}
            onLogoutEverywhere={async () => {
              try {
                await signOutEverywhere();
              } catch {
                // Credentials still leave the browser when server revocation is unavailable.
              } finally {
                navigate('/', { replace: true });
              }
            }}
            workspace={
              me.data?.tenant ? { name: me.data.tenant.name, role: me.data.tenant.role } : undefined
            }
            isPlatformAdmin={me.data?.user?.isPlatformAdmin ?? false}
            pendingRegistrationCount={me.data?.user?.pendingRegistrationCount ?? 0}
          />
        </NotificationInboxProvider>
      ) : null}
    </RequireAuth>
  );
}
