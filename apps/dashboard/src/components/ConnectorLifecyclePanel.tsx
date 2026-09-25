import { productPath } from '../lib/routes';
import { useIncidents } from '../lib/useIncidents';
import { useEffect, useState } from 'react';
import { authenticatedFetch } from '../lib/authenticatedFetch';
import type { CredentialGetter } from '../lib/request-credentials';
import type { ConnectorSummary } from '../lib/connectors';
import { config } from '../config';

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
  });
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
      `${config.apiBaseUrl}/incidents/${incidentId}/workspace`,
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
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function run(mode: 'preview' | 'bind' | 'reconcile') {
    setBusy(true);
    setMessage('');
    setCanonicalIncidentId('');
    try {
      const response = await authenticatedFetch(
        `${config.apiBaseUrl}/connectors/${connector.type}/${connector.id}/lifecycle`,
        getCredentials,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            ...preview,
            mode,
            signalId: signalId.trim(),
            monitorId: monitorId.trim(),
            scope,
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
        throw new Error(
          [result.error ?? result.reason ?? 'Verification unavailable', result.nextStep]
            .filter(Boolean)
            .join(' '),
        );
      }
      if (mode === 'preview') setPreview(result);
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
      setMessage(error instanceof Error ? error.message : 'Verification unavailable');
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
            disabled={busy || !signalId.trim() || !monitorId.trim()}
            onClick={() => void run('preview')}
          >
            Preview provider evidence
          </button>
          <button className="sre-action" disabled={busy} onClick={() => void run('reconcile')}>
            Reconcile bound episodes
          </button>
        </div>
        {preview && (
          <>
            <p className="text-sm">
              Verified episode: {String(preview.startsAt)}. Current provider result:{' '}
              {String(preview.status)}.
            </p>
            {preview.nativeAssociation && (
              <p className="text-sm text-warning">
                {preview.nativeAssociation === 'cycle_key_required'
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
        <a
          className="text-sm text-accent underline"
          href={productPath(`incidents/${canonicalIncidentId}`)}
        >
          Review canonical incident
        </a>
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
  const supportsRead = ['read', 'events_and_read'].includes(
    connector.capabilities?.alertLifecycle ?? 'none',
  );
  return (
    <section className="mt-6 space-y-3 rounded border border-line p-4">
      <h2 className="font-medium">Alert lifecycle coverage</h2>
      <p className="text-sm text-ink-muted">
        {connector.capabilities?.alertLifecycle === 'none'
          ? 'Evidence access only. This connector cannot authorize incident recovery.'
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
