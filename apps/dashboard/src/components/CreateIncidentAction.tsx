import { useId, useRef, useState, type FormEvent } from 'react';
import { SetupActions } from './SetupDialogSlots';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { createManualIncident, type ManualIncidentDraft } from '../lib/investigations';
import { incidentPath } from '../lib/routes';
import { SetupDialog } from './SetupDialog';

const initialDraft: Omit<ManualIncidentDraft, 'requestId'> = {
  title: '',
  description: '',
  service: '',
  severity: 'sev3',
};

export function CreateIncidentAction() {
  const formId = useId();
  const { getCredentials } = useSession();
  const navigate = useNavigate();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestIdRef = useRef<string | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (pending) return;
    setOpen(false);
    setDraft(initialDraft);
    setError(null);
    requestIdRef.current = null;
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    requestIdRef.current ??= globalThis.crypto.randomUUID();
    try {
      const result = await createManualIncident(config.apiBaseUrl, getCredentials, {
        requestId: requestIdRef.current,
        title: draft.title.trim(),
        description: draft.description.trim(),
        service: draft.service.trim(),
        severity: draft.severity,
      });
      navigate(incidentPath(result.incidentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the incident.');
      setPending(false);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md bg-strong px-3 py-2 text-sm font-semibold text-on-strong hover:bg-strong-hover"
      >
        Create incident
      </button>
      {open && (
        <SetupDialog
          title="Create incident"
          size="standard"
          closeLabel="Cancel"
          busy={pending}
          returnFocusTo={triggerRef.current}
          onClose={close}
        >
          <form id={formId} onSubmit={(event) => void submit(event)}>
            <p className="text-sm text-ink-muted">
              Start a one-off investigation from your report. This does not create or modify an
              upstream alert.
            </p>

            <label className="mt-4 block font-medium text-ink-secondary">
              Incident title
              <input
                required
                autoFocus
                maxLength={300}
                value={draft.title}
                onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                placeholder="Checkout latency increased after deployment"
                className="mt-1 w-full rounded border border-line-strong px-3 py-2"
              />
            </label>

            <label
              htmlFor="manual-incident-service"
              className="mt-4 block font-medium text-ink-secondary"
            >
              Service or system
            </label>
            <input
              id="manual-incident-service"
              required
              maxLength={200}
              value={draft.service}
              onChange={(event) => setDraft({ ...draft, service: event.target.value })}
              placeholder="checkout-api, argocd, or kube-etcd"
              aria-describedby="manual-incident-service-help"
              className="mt-1 w-full rounded border border-line-strong px-3 py-2"
            />
            <span
              id="manual-incident-service-help"
              className="mt-1 block text-xs font-normal text-ink-muted"
            >
              Used to focus topology, logs, metrics, deployments, and code evidence.
            </span>

            <label className="mt-4 block font-medium text-ink-secondary">
              Severity
              <select
                value={draft.severity}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    severity: event.target.value as ManualIncidentDraft['severity'],
                  })
                }
                className="mt-1 w-full rounded border border-line-strong px-3 py-2"
              >
                <option value="sev1">SEV1, critical impact</option>
                <option value="sev2">SEV2, significant impact</option>
                <option value="sev3">SEV3, limited or unknown impact</option>
              </select>
            </label>

            <label className="mt-4 block font-medium text-ink-secondary">
              What should SRE Platform investigate?
              <textarea
                required
                maxLength={4_000}
                rows={6}
                value={draft.description}
                onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                placeholder="Describe the symptom, impact, when it started, and any evidence already checked."
                className="mt-1 w-full resize-y rounded border border-line-strong px-3 py-2"
              />
            </label>

            <p className="mt-4 rounded-md border border-warning-line bg-warning-soft p-3 text-sm text-warning">
              Creating the incident starts the configured model. Token usage and cost are recorded
              on its workspace.
            </p>
            {error && (
              <p role="alert" className="mt-3 text-sm font-medium text-critical">
                {error}
              </p>
            )}
            <SetupActions>
              <button
                type="button"
                disabled={pending}
                onClick={close}
                className="rounded border border-line-strong px-3 py-2 font-medium hover:bg-surface-subtle disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                form={formId}
                disabled={pending}
                className="rounded bg-strong px-3 py-2 font-semibold text-on-strong hover:bg-strong-hover disabled:opacity-50"
              >
                {pending ? 'Creating…' : 'Create and investigate'}
              </button>
            </SetupActions>
          </form>
        </SetupDialog>
      )}
    </>
  );
}
