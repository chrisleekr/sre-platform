import { incidentPath } from '../lib/routes';
import { useIncidents } from '../lib/useIncidents';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import type { CredentialGetter } from '../lib/request-credentials';
import { RequestError, requestErrorMessage } from '../lib/request-error';
import type { ConnectorSummary } from '../lib/connectors';
import { config } from '../config';

/** A successful preview. The three versions are the optimistic-concurrency token a bind echoes. */
interface EpisodePreview {
  startsAt: string;
  status: string;
  nativeAssociation?: 'cycle_key_required' | 'awaiting_authenticated_event';
  signalVersion: number;
  lifecycleVersion: number;
  connectorVersion: number;
  /** The inputs this preview was requested for; a response for older inputs is never shown. */
  request: string;
}

// The route returns provider readEpisode codes verbatim; operators need the action, not the code.
const UNVERIFIED_MESSAGES: Record<string, string> = {
  exact_group_required: 'Enter the exact alert group scope.',
  invalid_monitor_id: 'The monitor ID is not a valid provider monitor ID.',
  invalid_monitor_or_event_time:
    'The monitor ID or the signal time is not valid for this provider.',
  monitor_identity_mismatch: 'The provider returned a different monitor for this ID.',
  episode_order_unverified:
    'The provider shows no trigger for this monitor and group before the signal arrived.',
  group_state_unverified: 'The provider group state is neither alerting nor cleared.',
  monitor_state_unavailable: 'The provider monitor is paused or reports neither up nor down.',
  unsupported_check_family: 'Only uptime checks can be verified.',
  invalid_episode_time: 'The signal has no usable episode time.',
  unsupported_period_schema: 'The provider returned history in an unsupported format.',
  invalid_history_cursor: 'The provider returned an unusable history page.',
  history_window_exhausted: 'The episode is older than the history the provider returns.',
  episode_not_retained: 'The provider no longer retains this episode.',
  ambiguous_episode: 'More than one provider episode matches this signal.',
  conflicting_provider_evidence: 'Provider history and alert records disagree about this episode.',
  provider_read_failed: 'The provider could not be read. Check the connection and retry.',
};
const UNVERIFIED_FALLBACK = 'Provider evidence could not be verified.';
const REQUEST_FALLBACK = 'Verification unavailable. Retry, or check the connection.';
// The open scope takes no cursor, so the picker reads the server maximum in one page.
const INCIDENT_LIMIT = 100;

/** Previews exact provider evidence before an administrator binds a historical signal. */
function LifecycleBindingForm({
  connector,
  getCredentials,
}: {
  connector: ConnectorSummary;
  getCredentials: CredentialGetter;
  canConfigure: boolean;
}) {
  const [signalId, setSignalId] = useState('');
  const [incidentId, setIncidentId] = useState('');
  const [signals, setSignals] = useState<
    Array<{ id: string; summary: string; provider?: string; state: string }>
  >([]);
  const incidentList = useIncidents({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    state: 'open',
    limit: INCIDENT_LIMIT,
  });
  const openCount = incidentList.counts?.open ?? 0;
  const [signalsFailed, setSignalsFailed] = useState(false);
  // Reselecting the same incident does not change incidentId, so retry needs its own dependency.
  const [signalsAttempt, setSignalsAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setSignals([]);
    setSignalId('');
    setPreview(null);
    setSignalsFailed(false);
    if (!incidentId) return;
    void authenticatedFetch(
      `${config.apiBaseUrl}/incidents/${encodeURIComponent(incidentId)}/workspace`,
      getCredentials,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Unable to load incident signals');
        const detail = (await response.json()) as {
          signals?: Array<{ id: string; summary: string; provider?: string; state: string }>;
        };
        if (current) setSignals(detail.signals ?? []);
      })
      .catch(() => {
        if (current) setSignalsFailed(true);
      });
    return () => {
      current = false;
    };
  }, [incidentId, getCredentials, signalsAttempt]);
  const [monitorId, setMonitorId] = useState('');
  const [scope, setScope] = useState('');
  const [cycleKey, setCycleKey] = useState('');
  const [canonicalIncidentId, setCanonicalIncidentId] = useState('');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<EpisodePreview | null>(null);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState('');
  const [busy, setBusy] = useState(false);
  // Inputs stay editable while a preview is in flight, so a late response must match what is typed now.
  const request = JSON.stringify([
    signalId.trim(),
    monitorId.trim(),
    scope.trim(),
    cycleKey.trim(),
  ]);
  const currentPreview = preview?.request === request ? preview : null;
  async function run(mode: 'preview' | 'bind' | 'reconcile') {
    setBusy(true);
    setMessage('');
    setFailure('');
    setCanonicalIncidentId('');
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/connectors/${connector.type}/${connector.id}/lifecycle`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(mode === 'bind' && currentPreview
              ? {
                  signalVersion: currentPreview.signalVersion,
                  lifecycleVersion: currentPreview.lifecycleVersion,
                  connectorVersion: currentPreview.connectorVersion,
                }
              : {}),
            mode,
            signalId: signalId.trim(),
            monitorId: monitorId.trim(),
            // A blank scope must reach the server as absent so it fails before any provider read.
            ...(scope.trim() ? { scope: scope.trim() } : {}),
            ...(connector.type === 'datadog' && cycleKey.trim()
              ? { cycleKey: cycleKey.trim() }
              : {}),
            family: connector.type === 'statuscake' ? 'uptime' : undefined,
            reason,
          }),
        },
      );
      const result = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        if (typeof result.canonicalIncidentId === 'string')
          setCanonicalIncidentId(result.canonicalIncidentId);
        const unverified =
          typeof result.reason === 'string'
            ? Object.hasOwn(UNVERIFIED_MESSAGES, result.reason)
              ? UNVERIFIED_MESSAGES[result.reason]
              : UNVERIFIED_FALLBACK
            : undefined;
        const error = typeof result.error === 'string' ? result.error : unverified;
        if (!error) throw new RequestError(REQUEST_FALLBACK, response.status);
        throw new RequestError(
          [error, typeof result.nextStep === 'string' ? result.nextStep : '']
            .filter(Boolean)
            .join(' '),
          response.status,
        );
      }
      if (mode === 'preview') setPreview({ ...(result as unknown as EpisodePreview), request });
      else {
        setPreview(null);
        setMessage(
          String(
            result.nextStep ??
              `Reconciliation complete: ${result.verified ?? 0} verified episodes; ${Array.isArray(result.unresolved) ? result.unresolved.length : 0} need review.`,
          ),
        );
      }
    } catch (error) {
      setPreview(null);
      // Fetch, token and parse failures carry runtime text; only route guidance is shown.
      setFailure(requestErrorMessage(error, REQUEST_FALLBACK));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <>
        <p className="text-sm text-ink-muted">
          For an existing incident, preview the original signal against its exact provider monitor.
          Binding preserves the original history and enables bounded provider reconciliation.
        </p>
        {incidentList.error && (
          <p role="alert" className="text-sm text-critical">
            Unable to load open incidents.
          </p>
        )}
        {openCount > incidentList.incidents.length && (
          <p role="status" className="text-sm text-warning">
            Showing the first {incidentList.incidents.length} of {openCount} open incidents, highest
            priority first.
          </p>
        )}
        <label className="block text-sm">
          Open incident
          <select
            className="sre-field mt-1 w-full"
            value={incidentId}
            onChange={(event) => setIncidentId(event.target.value)}
          >
            <option value="">Select an incident</option>
            {incidentList.incidents.map((incident) => (
              <option key={incident.id} value={incident.id}>
                {incident.title ?? incident.service} ({incident.severity})
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          Provider signal
          <select
            className="sre-field mt-1 w-full"
            value={signalId}
            onChange={(event) => {
              setSignalId(event.target.value);
              setCycleKey('');
              setPreview(null);
            }}
            disabled={!incidentId}
          >
            <option value="">Select a signal</option>
            {signals.map((signal) => (
              <option key={signal.id} value={signal.id}>
                {signal.provider ?? 'Notification'}: {signal.summary.slice(0, 160)} ({signal.state})
              </option>
            ))}
          </select>
        </label>
        {signalsFailed && (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-critical">
            Unable to load incident signals.
            <button
              type="button"
              className="sre-action"
              onClick={() => setSignalsAttempt((attempt) => attempt + 1)}
            >
              Retry
            </button>
          </div>
        )}
        <label className="block text-sm">
          Provider monitor ID
          <input
            className="sre-field mt-1 w-full"
            value={monitorId}
            onChange={(event) => {
              setMonitorId(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        {connector.type === 'datadog' && (
          <label className="block text-sm">
            Exact alert group scope
            <input
              className="sre-field mt-1 w-full"
              value={scope}
              onChange={(event) => {
                setScope(event.target.value);
                setPreview(null);
              }}
            />
          </label>
        )}
        {connector.type === 'datadog' && (
          <>
            <label className="block text-sm">
              Native alert cycle key (optional)
              <input
                type="password"
                autoComplete="off"
                className="sre-field mt-1 w-full"
                value={cycleKey}
                onChange={(event) => {
                  setCycleKey(event.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <p className="text-sm text-ink-muted">
              Use alert_cycle_key from a retained authenticated provider payload. Without it, API
              read reconciliation remains available but native association cannot be established.
              After binding, resend the exact Triggered payload to this connection’s webhook with
              its bearer credential kept private.
            </p>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="sre-action"
            disabled={
              busy ||
              !signalId.trim() ||
              !monitorId.trim() ||
              (connector.type === 'datadog' && !scope.trim())
            }
            onClick={() => void run('preview')}
          >
            Preview provider evidence
          </button>
          <button className="sre-action" disabled={busy} onClick={() => void run('reconcile')}>
            Reconcile bound episodes
          </button>
        </div>
        {currentPreview && (
          <>
            <p className="text-sm">
              Verified episode: {currentPreview.startsAt}. Current provider result:{' '}
              {currentPreview.status}.
            </p>
            {currentPreview.nativeAssociation && (
              <p className="text-sm text-warning">
                {currentPreview.nativeAssociation === 'cycle_key_required'
                  ? 'API evidence verified. Native association requires an explicit cycle key.'
                  : 'Native association pending an authenticated delivery matching this exact cycle and start.'}
              </p>
            )}
            <label className="block text-sm">
              Binding reason
              <input
                className="sre-field mt-1 w-full"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
            <button
              className="sre-action sre-action-primary"
              disabled={busy || !reason.trim()}
              onClick={() => void run('bind')}
            >
              Bind this episode
            </button>
          </>
        )}
      </>
      {canonicalIncidentId && (
        <a className="text-sm text-accent underline" href={incidentPath(canonicalIncidentId)}>
          Review canonical incident
        </a>
      )}
      {failure && (
        <p role="alert" className="text-sm text-critical">
          {failure}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
    </div>
  );
}

/** Shows coverage without loading incidents for connectors that cannot verify episodes. */
export function ConnectorLifecyclePanel(props: {
  connector: ConnectorSummary;
  getCredentials: CredentialGetter;
  canConfigure: boolean;
}) {
  const { connector, canConfigure } = props;
  const lifecycle = connector.capabilities?.alertLifecycle ?? 'none';
  const supportsRead = lifecycle === 'read' || lifecycle === 'events_and_read';
  return (
    <section className="mt-6 space-y-3 rounded border border-line p-4">
      <h2 className="font-medium">Alert lifecycle coverage</h2>
      <p className="text-sm text-ink-muted">
        {lifecycle === 'none'
          ? 'Evidence access only. This connector cannot authorize incident recovery.'
          : lifecycle === 'structured_snapshot'
            ? 'Polled snapshots are evidence only. This connector has no provider alert episode to bind, so it cannot authorize incident recovery.'
            : 'Automatic recovery requires an authenticated provider episode or an exact saved monitor binding. Slack notification wording and model output remain advisory.'}
      </p>
      {Boolean(connector.lifecycle?.pendingEpisodes) && (
        <p role="status" className="text-sm text-warning">
          {connector.lifecycle?.pendingEpisodes} provider episodes need trigger, cycle association
          or timestamp review. Inspect delivery diagnostics, bind the explicit cycle if required,
          then resend the corrected authenticated provider payload. No episode start or recovery has
          been inferred.
        </p>
      )}
      {connector.lifecycle?.failureCategory && (
        <p role="status" className="text-sm text-warning">
          Verification needs review: {connector.lifecycle.failureCategory}
        </p>
      )}
      {supportsRead && canConfigure && <LifecycleBindingForm {...props} />}
    </section>
  );
}
