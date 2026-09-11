import { requestErrorMessage } from '../lib/request-error';
import { useState } from 'react';
import { useSession } from '../auth';
import { InlineAlert } from '../components/PageState';
import { adminRequest } from './api';
import { AdminPage } from './AdminPage';
import { useAdminData } from './useAdminData';

interface Founding {
  id: string;
  status: string;
  requestedName: string;
  slug: string;
  declaredDomain: string | null;
  founderEmail: string | null;
  issuer: string | null;
  failureReason: string | null;
  createdAt: string;
}

/** Lets platform administrators review and recover workspace registrations. */
export function RegistrationsPage() {
  const { getCredentials } = useSession();
  const query = useAdminData(() =>
    adminRequest<{ foundings: Founding[] }>(getCredentials, '/foundings'),
  );
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const mutate = async (founding: Founding, action: 'approve' | 'reject' | 'retry') => {
    setBusy(`${founding.id}:${action}`);
    setError(undefined);
    try {
      await adminRequest(getCredentials, `/foundings/${founding.id}/${action}`, {
        method: 'POST',
        body: action === 'reject' ? { reason: reasons[founding.id] ?? '' } : undefined,
      });
      await query.refresh();
    } catch (cause) {
      setError(requestErrorMessage(cause, 'Registration update failed.'));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <AdminPage
      title="Registrations"
      description="Review workspace requests and recover failed provisioning without leaving the audit trail."
      loading={query.loading}
      error={query.error}
      onRetry={() => void query.refresh()}
    >
      {error && <InlineAlert message={error} />}
      <div className="grid gap-3">
        {query.data?.foundings.length === 0 && (
          <p className="rounded-xl border border-line bg-surface p-5 text-sm text-ink-muted">
            No workspace registrations need review.
          </p>
        )}
        {query.data?.foundings.map((founding) => (
          <article
            key={founding.id}
            className="rounded-xl border border-line bg-surface p-5 shadow-sm"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-ink">{founding.requestedName}</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  {founding.founderEmail ?? 'Founder identity pending'} ·{' '}
                  {founding.declaredDomain ?? founding.issuer ?? 'Directory pending'}
                </p>
                <p className="mt-1 font-mono text-xs text-ink-faint">/{founding.slug}</p>
              </div>
              <span className="rounded-full bg-surface-subtle px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-ink-secondary">
                {founding.status.replaceAll('_', ' ')}
              </span>
            </div>
            {founding.failureReason && (
              <p className="mt-3 rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
                {founding.failureReason}
              </p>
            )}
            {founding.status === 'pending' && (
              <div className="mt-4 grid gap-3 border-t border-line pt-4 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
                <input
                  aria-label={`Rejection reason for ${founding.requestedName}`}
                  value={reasons[founding.id] ?? ''}
                  onChange={(event) =>
                    setReasons((current) => ({ ...current, [founding.id]: event.target.value }))
                  }
                  placeholder="Reason required only when rejecting"
                  className="rounded-lg border border-line-strong bg-canvas px-3 py-2 text-sm"
                />
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void mutate(founding, 'reject')}
                  className="sre-hit-target rounded-lg border border-critical-line px-4 py-2 text-sm font-semibold text-critical hover:bg-critical-soft disabled:opacity-60"
                >
                  Reject
                </button>
                <button
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void mutate(founding, 'approve')}
                  className="sre-hit-target rounded-lg bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
                >
                  Approve
                </button>
              </div>
            )}
            {founding.status === 'failed' && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void mutate(founding, 'retry')}
                className="sre-hit-target mt-4 rounded-lg bg-strong px-4 py-2 text-sm font-semibold text-on-strong disabled:opacity-60"
              >
                Retry provisioning
              </button>
            )}
          </article>
        ))}
      </div>
    </AdminPage>
  );
}
