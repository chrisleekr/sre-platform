import { requestErrorMessage } from '../lib/request-error';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { adminRequest } from '../admin/api';
import { setImpersonationSession, useImpersonationSession } from '../lib/impersonation';
import { invalidateMe } from '../lib/me-store';

function remaining(expiresAt: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Keeps bounded support access visible and immediately revocable. */
export function ImpersonationBanner() {
  const session = useImpersonationSession();
  const auth = useSession();
  const navigate = useNavigate();
  const [now, setNow] = useState(Date.now());
  const [ending, setEnding] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!session) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [session]);

  if (!session) return null;
  const end = async (): Promise<void> => {
    setEnding(true);
    setError(undefined);
    try {
      await adminRequest(auth.getCredentials, `/impersonation/${session.id}/end`, {
        method: 'POST',
      });
      setImpersonationSession(null);
      invalidateMe(auth.sessionKey ?? null);
      navigate('/admin', { replace: true });
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Support session could not be ended.'));
    } finally {
      setEnding(false);
    }
  };

  return (
    <section
      aria-label="Platform support session"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-warning-line bg-warning-soft px-4 py-3 text-sm text-warning sm:px-5"
    >
      <div className="min-w-0">
        <p className="font-semibold">
          Viewing {session.tenantName} as a platform administrator
          <span className="ml-2 font-mono tabular-nums">{remaining(session.expiresAt, now)}</span>
        </p>
        <p className="truncate text-xs">{session.reason}</p>
        {error && (
          <p role="alert" className="mt-1 text-critical">
            {error}
          </p>
        )}
      </div>
      <button
        type="button"
        disabled={ending}
        onClick={() => void end()}
        className="sre-hit-target rounded-md border border-warning-line bg-surface px-3 py-2 font-semibold hover:bg-warning-muted disabled:opacity-60"
      >
        {ending ? 'Ending…' : 'End now'}
      </button>
    </section>
  );
}
