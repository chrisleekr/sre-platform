import { checkResponse, requestErrorMessage } from '../../lib/request-error';
import type { CredentialGetter } from '../../lib/request-credentials';
import { credentialHeaders } from '../../lib/request-credentials';
import { sessionFetch } from '../../lib/session-fetch';
import { useSession } from '../../auth';
import { useState } from 'react';
import { config } from '../../config';
import { formatAbsoluteTime } from '../../lib/time';
import type { IncidentSignal, IncidentWorkspaceData } from '../../lib/types';
import { useSlackPermalink } from '../../lib/useSlackPermalink';
import { InlineLoadingSkeleton } from '../LoadingSkeleton';

export type LifecycleStatus = 'open' | 'mitigated' | 'resolved' | 'closed';

const LIFECYCLE_ACTIONS: Record<LifecycleStatus, Array<{ to: LifecycleStatus; label: string }>> = {
  open: [
    { to: 'mitigated', label: 'Mark mitigated' },
    { to: 'resolved', label: 'Resolve' },
    { to: 'closed', label: 'Close' },
  ],
  mitigated: [
    { to: 'open', label: 'Return to open' },
    { to: 'resolved', label: 'Resolve' },
    { to: 'closed', label: 'Close' },
  ],
  resolved: [
    { to: 'open', label: 'Reopen' },
    { to: 'closed', label: 'Close' },
  ],
  closed: [{ to: 'open', label: 'Reopen' }],
};

export function lifecycleActions(status: string) {
  return LIFECYCLE_ACTIONS[status as LifecycleStatus] ?? [];
}

export function signalHeadline(summary: string): string {
  const alertField = /(?:^|\n)\*Alert:\*\s*([^\n]+)/i.exec(summary)?.[1]?.trim();
  if (alertField) return alertField;
  const firstLine = summary.split('\n', 1)[0]?.trim() ?? '';
  return firstLine.length > 180 ? `${firstLine.slice(0, 179)}…` : firstLine;
}

/** Targets named by an Alertmanager observation. These are display evidence, never mutation authority. */
export function signalTargets(summary: string): string[] {
  const targets = summary.match(/\b(?:\d{1,3}\.){3}\d{1,3}:\d+\b/g) ?? [];
  return [...new Set(targets)];
}

function newestFirst(left: IncidentSignal, right: IncidentSignal): number {
  return Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt);
}

function SignalNoiseFeedback({
  workspace,
  signal,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  signal: IncidentSignal;
  getCredentials?: CredentialGetter;
  onChanged?: () => void;
}) {
  const current = (workspace.feedback ?? []).find(
    (feedback) => feedback.targetType === 'noise' && feedback.targetId === signal.id,
  );
  const [decision, setDecision] = useState<'noise' | 'not_noise' | null>(null);
  const [rationale, setRationale] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!getCredentials || !onChanged || !workspace.viewerUserId) return null;

  const submit = async () => {
    if (!decision || !rationale.trim()) return;
    setPending(true);
    setError(null);
    try {
      const response = await sessionFetch(
        `${config.apiBaseUrl}/incidents/${workspace.incident.id}/feedback`,
        {
          method: 'POST',
          headers: {
            ...credentialHeaders(await getCredentials()),
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            targetType: 'noise',
            targetId: signal.id,
            decision,
            rationale: rationale.trim(),
            replacement: null,
          }),
        },
      );
      await checkResponse(response, 'Signal feedback could not be saved.');
      setDecision(null);
      setRationale('');
      onChanged();
    } catch (caught) {
      setError(requestErrorMessage(caught, 'Signal feedback could not be saved.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-2 text-xs">
      {current && (
        <p className="text-ink-muted">
          Responder marked this {current.decision === 'noise' ? 'as noise' : 'as actionable'}:{' '}
          {current.rationale}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => setDecision('noise')}
          className="min-h-9 rounded border border-line-strong bg-surface px-2 py-1 font-semibold text-ink-secondary"
        >
          Mark as noise
        </button>
        <button
          type="button"
          onClick={() => setDecision('not_noise')}
          className="min-h-9 rounded border border-line-strong bg-surface px-2 py-1 font-semibold text-ink-secondary"
        >
          Mark actionable
        </button>
      </div>
      {decision && (
        <div className="mt-2 rounded border border-line bg-surface-subtle p-2">
          <label className="font-semibold text-ink-secondary">
            Evidence for this decision
            <input
              value={rationale}
              onChange={(event) => setRationale(event.target.value)}
              maxLength={1_000}
              className="mt-1 min-h-10 w-full rounded border border-line-strong bg-surface px-2 py-1 text-sm"
            />
          </label>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => setDecision(null)} className="min-h-9 px-2 py-1">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending || !rationale.trim()}
              className="min-h-9 rounded bg-strong px-2 py-1 font-semibold text-on-strong disabled:opacity-50"
            >
              {pending ? 'Saving…' : 'Save decision'}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-1 text-critical">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function SignalCard({
  workspace,
  signal,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  signal: IncidentSignal;
  getCredentials?: CredentialGetter;
  onChanged?: () => void;
}) {
  const targets = signalTargets(signal.summary);
  let materialAssessment: string | null = null;
  if (signal.materialHash) {
    materialAssessment =
      signal.lastInvestigatedVersion === signal.version
        ? 'Latest material state assessed'
        : 'Latest material state awaiting assessment';
  }
  return (
    <li className="rounded-md border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium text-ink">{signalHeadline(signal.summary)}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
            signal.state === 'resolved'
              ? 'bg-success-muted text-success'
              : signal.state === 'firing'
                ? 'bg-critical-muted text-critical'
                : 'bg-warning-muted text-warning'
          }`}
        >
          {signal.state}
        </span>
      </div>
      {targets.length > 0 && (
        <p className="mt-2 flex flex-wrap gap-1" aria-label="Affected targets">
          {targets.map((target) => (
            <code
              key={target}
              className="rounded bg-surface-strong px-1.5 py-0.5 text-xs text-ink-secondary"
            >
              {target}
            </code>
          ))}
        </p>
      )}
      <p className="mt-1 text-xs text-ink-muted">
        {signal.provider ?? signal.surface} · {signal.channel} · {signal.lastEventType} · version{' '}
        {signal.version} · {formatAbsoluteTime(signal.lastSeenAt)}
      </p>
      {(signal.startsAt || materialAssessment) && (
        <p className="mt-1 text-xs text-ink-muted">
          {signal.startsAt ? `Episode started ${formatAbsoluteTime(signal.startsAt)}` : null}
          {signal.startsAt && materialAssessment ? ' · ' : null}
          {materialAssessment}
        </p>
      )}
      {signal.correlationMethod && signal.correlationRationale && (
        <div className="mt-3 rounded border border-info-line bg-info-soft p-2.5 text-xs text-info">
          <p className="font-semibold">
            {signal.correlationMethod === 'stable_subject_window'
              ? 'Grouped into this incident'
              : 'Started a separate incident'}
            {signal.correlationConfidence !== null && signal.correlationConfidence !== undefined
              ? ` · ${signal.correlationConfidence}% policy match`
              : ''}
          </p>
          <p className="mt-1">{signal.correlationRationale}</p>
          {signal.correlationMethod === 'stable_subject_window' &&
            signal.correlationWindowExpiresAt &&
            signal.correlationMaxAgeAt && (
              <p className="mt-1 text-info">
                Rolling window ends {formatAbsoluteTime(signal.correlationWindowExpiresAt)}. Hard
                incident-age stop {formatAbsoluteTime(signal.correlationMaxAgeAt)}.
              </p>
            )}
          {signal.correlationFeatures && signal.correlationFeatures.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer font-medium">Decision evidence</summary>
              <ul className="mt-1 list-disc pl-5">
                {signal.correlationFeatures.map((feature) => (
                  <li key={feature}>{feature.replaceAll('_', ' ')}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
      {signal.summary !== signalHeadline(signal.summary) && (
        <details className="mt-2 text-xs text-ink-muted">
          <summary className="cursor-pointer font-medium">Raw provider observation</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-code p-3 text-code-ink">
            {signal.summary}
          </pre>
        </details>
      )}
      <SignalNoiseFeedback
        workspace={workspace}
        signal={signal}
        getCredentials={getCredentials}
        onChanged={onChanged}
      />
    </li>
  );
}

export function SignalOverview({
  workspace,
  getCredentials,
  onChanged,
}: {
  workspace: IncidentWorkspaceData;
  getCredentials?: CredentialGetter;
  onChanged?: () => void;
}) {
  const signals = workspace.signals ?? [];
  const manual = workspace.incident.alertSource === 'manual';
  const active = signals.filter((signal) => signal.state !== 'resolved').sort(newestFirst);
  const cleared = signals.filter((signal) => signal.state === 'resolved').sort(newestFirst);
  const targetStates = new Map<string, { state: IncidentSignal['state']; observedAt: string }>();
  for (const signal of [...signals].sort(newestFirst).reverse()) {
    for (const target of signalTargets(signal.summary)) {
      targetStates.set(target, { state: signal.state, observedAt: signal.lastSeenAt });
    }
  }
  return (
    <section
      className="rounded-lg border border-line bg-surface p-4"
      aria-labelledby="signals-title"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="signals-title" className="font-semibold text-ink">
          {manual ? 'Investigation origin' : 'Alert episodes'}
        </h2>
        <span className="text-xs text-ink-muted">
          {signals.length === 0
            ? manual
              ? 'Human report'
              : 'No tracked signal'
            : active.length === 0
              ? 'All signals cleared'
              : `${active.length} unresolved record${active.length === 1 ? '' : 's'}`}
        </span>
      </div>
      {signals.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">
          {manual
            ? 'This investigation was opened by a responder. No provider signal is expected.'
            : 'This incident predates signal tracking.'}
        </p>
      ) : (
        <div className="mt-3 space-y-3">
          {!manual && (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="min-w-full text-left text-xs">
                <caption className="px-3 py-2 text-left font-semibold text-ink">
                  Occurrence ledger
                </caption>
                <thead className="border-y border-line bg-surface-subtle text-ink-muted">
                  <tr>
                    <th className="px-3 py-2 font-semibold">Episode</th>
                    <th className="px-3 py-2 font-semibold">State</th>
                    <th className="px-3 py-2 font-semibold">First seen</th>
                    <th className="px-3 py-2 font-semibold">Last seen</th>
                    <th className="px-3 py-2 font-semibold">Updates</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {[...signals]
                    .sort(
                      (left, right) => Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt),
                    )
                    .map((signal) => (
                      <tr key={signal.id}>
                        <td className="max-w-80 px-3 py-2 font-medium text-ink">
                          <span className="block truncate">
                            {signal.alertName || signalHeadline(signal.summary)}
                          </span>
                          <span className="font-normal text-ink-muted">
                            {signal.provider ?? signal.surface}
                          </span>
                        </td>
                        <td className="px-3 py-2 capitalize text-ink-secondary">{signal.state}</td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                          {formatAbsoluteTime(signal.firstSeenAt)}
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-ink-muted">
                          {formatAbsoluteTime(signal.lastSeenAt)}
                        </td>
                        <td className="px-3 py-2 text-ink-secondary">v{signal.version}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
          {targetStates.size > 0 && (
            <div className="rounded-md border border-line bg-surface-subtle p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                Latest provider observation by target
              </p>
              <ul className="mt-2 flex flex-wrap gap-2">
                {[...targetStates.entries()]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([target, observation]) => (
                    <li
                      key={target}
                      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        observation.state === 'resolved'
                          ? 'bg-success-muted text-success'
                          : observation.state === 'firing'
                            ? 'bg-critical-muted text-critical'
                            : 'bg-warning-muted text-warning'
                      }`}
                      title={`Observed ${formatAbsoluteTime(observation.observedAt)}`}
                    >
                      {target} · {observation.state}
                    </li>
                  ))}
              </ul>
              <p className="mt-2 text-xs text-ink-muted">
                Alertmanager can aggregate several targets into one Slack notification. This rollup
                uses only the latest recorded provider observation for each named target; verify
                current telemetry before resolving the incident.
              </p>
            </div>
          )}
          {active.length > 0 && (
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-critical">
                Unresolved notification records
              </h3>
              <ul className="mt-2 space-y-2">
                {active.map((signal) => (
                  <SignalCard
                    key={signal.id}
                    workspace={workspace}
                    signal={signal}
                    getCredentials={getCredentials}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            </div>
          )}
          {cleared.length > 0 && (
            <details className="rounded-md border border-success-line bg-success-soft p-3">
              <summary className="cursor-pointer text-sm font-semibold text-success">
                {cleared.length} cleared notification record{cleared.length === 1 ? '' : 's'}
              </summary>
              <ul className="mt-3 space-y-2">
                {cleared.map((signal) => (
                  <SignalCard
                    key={signal.id}
                    workspace={workspace}
                    signal={signal}
                    getCredentials={getCredentials}
                    onChanged={onChanged}
                  />
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}

export function SlackThreadLink({ incidentId, channel }: { incidentId: string; channel: string }) {
  const { getCredentials } = useSession();
  const { permalink, loading, error, refresh } = useSlackPermalink(incidentId, {
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
  });

  if (loading) return <InlineLoadingSkeleton label="Loading Slack link…" className="h-4 w-32" />;
  if (permalink) {
    return (
      <a
        href={permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="font-semibold text-info underline decoration-info-line underline-offset-2 hover:text-info"
      >
        Slack · {channel} ↗
      </a>
    );
  }
  if (error) {
    return (
      <button
        type="button"
        onClick={refresh}
        className="font-medium text-critical underline underline-offset-2"
      >
        Retry Slack link
      </button>
    );
  }
  return <span className="text-ink-faint">Slack · {channel} · link unavailable</span>;
}
