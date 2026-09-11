import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { takeReturnTo } from '../local-session';
import { useApplicationSession } from '../lib/application-session';
import { ApplicationLoadingSkeleton } from './LoadingSkeleton';

/** Completes one OIDC callback before returning to the requested dashboard page. */
export function AuthCallback() {
  const oidc = useApplicationSession();
  const navigate = useNavigate();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void oidc
      .complete()
      .then((result) => {
        const remembered = takeReturnTo();
        navigate(result.returnTo ?? remembered ?? '/w', { replace: true });
      })
      .catch((error: unknown) =>
        navigate('/sign-in', {
          replace: true,
          state: {
            from: takeReturnTo() ?? '/w',
            recovery: true,
            error:
              error instanceof Error ? error.message : 'Sign-in could not be completed. Try again.',
          },
        }),
      );
  }, [navigate, oidc]);
  return <ApplicationLoadingSkeleton />;
}
