import { useState } from 'react';
import { SetupDialog } from './SetupDialog';
import { SetupActions } from './SetupDialogSlots';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import type { InvestigationDeclaration, InvestigationSubject } from '../lib/investigations';
import { incidentPath } from '../lib/routes';

export interface InvestigationActionProps {
  subject: InvestigationSubject;
  preview: { title: string; source: string; condition: string; severity: string };
  activeIncidentId?: string | null;
  declareInvestigation: (subject: InvestigationSubject) => Promise<InvestigationDeclaration>;
}

function Action({
  subject,
  preview,
  activeIncidentId,
  declareInvestigation,
  navigate,
}: InvestigationActionProps & { navigate: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await declareInvestigation(subject);
      navigate(incidentPath(result.incidentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the investigation.');
      setPending(false);
    }
  };
  if (activeIncidentId)
    return (
      <button
        type="button"
        className="rounded border border-line-strong bg-surface px-2.5 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-subtle"
        onClick={() => navigate(incidentPath(activeIncidentId))}
      >
        Open investigation
      </button>
    );
  return (
    <>
      <button
        type="button"
        className="rounded border border-line-strong bg-surface px-2.5 py-1.5 text-sm font-medium text-ink-secondary hover:bg-surface-subtle"
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        Investigate
      </button>
      {confirming ? (
        <SetupDialog
          title="Start investigation"
          closeLabel="Close"
          size="compact"
          busy={pending}
          onClose={() => setConfirming(false)}
        >
          <dl className="mt-4 grid gap-3 text-sm">
            {[
              ['Issue', preview.title],
              ['Source', preview.source],
              ['Current condition', preview.condition],
              ['Severity', preview.severity],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="font-medium text-ink-muted">{label}</dt>
                <dd className="mt-0.5 break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 rounded bg-warning-soft p-3 text-sm text-warning">
            A new investigation invokes the configured model. Its token usage and cost are recorded
            on the incident.
          </p>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-critical">
              {error}
            </p>
          ) : null}
          <SetupActions>
            <button
              type="button"
              className="rounded border border-line-strong px-3 py-2 text-sm"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rounded bg-strong px-3 py-2 text-sm font-medium text-on-strong disabled:opacity-50"
              disabled={pending}
              onClick={() => void start()}
            >
              {pending ? 'Starting…' : 'Start investigation'}
            </button>
          </SetupActions>
        </SetupDialog>
      ) : null}
    </>
  );
}

function RoutedAction(props: InvestigationActionProps) {
  const navigate = useNavigate();
  return <Action {...props} navigate={navigate} />;
}

/** Shared declaration interaction used wherever platform-owned evidence is already visible. */
export function InvestigationAction(props: InvestigationActionProps) {
  const routed = useInRouterContext();
  return routed ? (
    <RoutedAction {...props} />
  ) : (
    <Action {...props} navigate={(path) => window.history.pushState({}, '', path)} />
  );
}
