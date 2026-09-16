import type { IssueActionView } from '@sre/contracts';
export function IssueActionCard({
  action,
  busy,
  onDecision,
}: {
  action: IssueActionView;
  busy: boolean;
  onDecision: (id: string, decision: 'confirm' | 'cancel') => void;
}) {
  return (
    <article className="rounded-lg border border-line p-4">
      <h4 className="break-words font-medium">
        {action.repository}
        {action.number ? ` #${action.number}` : ' · New issue'} · {action.status}
      </h4>
      <p className="mt-1 break-words text-sm text-ink-muted">
        {action.destination.connectionName} · {action.destination.provider}
      </p>
      <p className="mt-1 break-words text-sm">{action.destination.repositoryUrl}</p>
      {action.status === 'draft' && (
        <>
          <p className="mt-1 text-xs text-ink-muted">
            Only the requester can confirm. Expires {new Date(action.expiresAt).toLocaleString()}.
          </p>
          <dl className="mt-3 space-y-3">
            {Object.entries(action.changes).map(([key, value]) => (
              <div key={key}>
                <dt className="text-xs font-semibold uppercase text-ink-muted">
                  {key === 'body' ? 'Description' : key}
                </dt>
                <dd className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words text-sm">
                  {Array.isArray(value) ? value.join(', ') || '(clear)' : value || '(clear)'}
                </dd>
              </div>
            ))}
          </dl>
          {action.before && (
            <details className="mt-3 text-sm">
              <summary>Current issue at preview time</summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                {JSON.stringify(action.before, null, 2)}
              </pre>
            </details>
          )}
          {action.canConfirm && (
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded bg-strong px-3 py-2 text-sm font-semibold text-on-strong"
                onClick={() => onDecision(action.id, 'confirm')}
              >
                {action.number ? 'Save changes' : 'Publish issue'}
              </button>
              <button
                type="button"
                disabled={busy}
                className="rounded border border-line-strong px-3 py-2 text-sm"
                onClick={() => onDecision(action.id, 'cancel')}
              >
                Discard draft
              </button>
            </div>
          )}
        </>
      )}
      {(action.status === 'executing' || action.status === 'unknown') && (
        <p className="mt-2 text-sm text-warning">
          The outcome is not confirmed. Inspect the repository and refresh status. Do not submit
          another change until you have checked.
        </p>
      )}
      {action.error && <p className="mt-2 text-sm text-critical">{action.error}</p>}
      {action.result && (
        <a
          href={action.result.url}
          target="_blank"
          rel="noreferrer"
          className="mt-2 block break-words text-sm text-link"
        >
          #{action.result.number} {action.result.title} · {action.result.state}
        </a>
      )}
    </article>
  );
}
