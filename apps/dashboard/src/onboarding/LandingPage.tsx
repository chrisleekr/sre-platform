import { Navigate } from 'react-router-dom';
import { useSession } from '../auth';
import { ApplicationLoadingSkeleton } from '../components/LoadingSkeleton';
import { nextWorkspaceRoute, useMe, WorkspaceStatusError } from '../lib/me-store';
import { PublicShell, primaryButton } from './shared';
import { SignInPage } from './SignInPage';

/** Public product entry and resumable sign-in choice. */
export function LandingPage() {
  const session = useSession();
  const me = useMe(
    session.getCredentials,
    session.status === 'authenticated',
    session.sessionKey,
    session.foundingId,
  );
  const sessionEnded = Boolean(
    session.status === 'authenticated' &&
    me.error instanceof WorkspaceStatusError &&
    me.error.status === 401,
  );
  if (session.status === 'authenticated') {
    if (sessionEnded)
      return (
        <SignInPage
          authNotice={
            session.foundingId
              ? 'Sign in again to resume your saved workspace setup.'
              : 'Your session ended. Sign in again.'
          }
        />
      );
    if (me.data)
      return (
        <Navigate
          to={
            me.data.state === 'active' && me.data.workspaces?.length > 1
              ? '/w/select'
              : nextWorkspaceRoute(me.data)
          }
          replace
        />
      );
    if (me.error) {
      return (
        <PublicShell>
          <p role="alert">Workspace status is unavailable.</p>
          <button type="button" className={`${primaryButton} mt-4`} onClick={me.refresh}>
            Try again
          </button>
        </PublicShell>
      );
    }
    return <ApplicationLoadingSkeleton />;
  }
  if (session.status === 'loading') return <ApplicationLoadingSkeleton />;
  return <SignInPage />;
}
