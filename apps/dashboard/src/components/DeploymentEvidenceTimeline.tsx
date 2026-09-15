import { Link } from 'react-router-dom';
import type { Deployment, GitOpsApplication, Incident } from '../lib/types';
import { incidentPath } from '../lib/routes';
import { incidentDisplayTitle } from '../lib/incidentTitle';
import { formatAbsoluteTime, relativeTime } from '../lib/time';

const CORRELATION_WINDOW_MS = 24 * 60 * 60 * 1_000;

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export function deploymentKey(deployment: Deployment): string {
  return `${deployment.source}/${deployment.repo}/${deployment.providerId ?? deployment.sha}/${deployment.deployedAt}`;
}

export function relatedIncidentsFor(deployment: Deployment, incidents: Incident[]): Incident[] {
  if (!deployment.service) return [];
  const deployedAt = Date.parse(deployment.deployedAt);
  return incidents.filter(
    (incident) =>
      incident.service === deployment.service &&
      Math.abs(Date.parse(incident.createdAt) - deployedAt) <= CORRELATION_WINDOW_MS,
  );
}

function matchingApplication(
  deployment: Deployment,
  applications: GitOpsApplication[],
): GitOpsApplication | undefined {
  return applications.find(
    (application) =>
      application.applicationName === deployment.service ||
      application.applicationId === deployment.repo ||
      deployment.repo.endsWith(`/${application.applicationName}`),
  );
}

export function DeploymentEvidenceTimeline({
  deployments,
  incidents,
  applications,
  selected,
  onSelect,
}: {
  deployments: Deployment[];
  incidents: Incident[];
  applications: GitOpsApplication[];
  selected: Deployment | null;
  onSelect: (deployment: Deployment) => void;
}) {
  const now = Date.now();
  const relatedIncidentIds = new Set(
    deployments.flatMap((deployment) =>
      relatedIncidentsFor(deployment, incidents).map((incident) => incident.id),
    ),
  );
  const events = [
    ...deployments.map((deployment) => ({
      type: 'deployment' as const,
      at: deployment.deployedAt,
      deployment,
    })),
    ...incidents
      .filter((incident) => relatedIncidentIds.has(incident.id))
      .map((incident) => ({ type: 'incident' as const, at: incident.createdAt, incident })),
  ]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, 24);
  const application = selected ? matchingApplication(selected, applications) : undefined;
  const related = selected ? relatedIncidentsFor(selected, incidents) : [];

  return (
    <section aria-labelledby="change-timeline-heading" className="mb-6">
      <div className="mb-3">
        <h2 id="change-timeline-heading" className="text-base font-semibold text-ink">
          Change and incident timeline
        </h2>
        <p className="text-sm text-ink-muted">
          Incident markers require the same service identity and must fall within 24 hours of a
          deployment. Proximity is evidence, not proof of causality.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(20rem,1fr)]">
        <ol className="space-y-2" aria-label="Recent change evidence">
          {events.length === 0 && (
            <li className="rounded-lg border border-line bg-surface p-4 text-sm text-ink-muted">
              No deployment or same-service incident evidence matches the current filters.
            </li>
          )}
          {events.map((event) =>
            event.type === 'deployment' ? (
              <li key={`deployment-${deploymentKey(event.deployment)}`}>
                <button
                  type="button"
                  aria-pressed={
                    selected ? deploymentKey(selected) === deploymentKey(event.deployment) : false
                  }
                  onClick={() => onSelect(event.deployment)}
                  className={`grid w-full min-w-0 gap-2 rounded-lg border p-3 text-left sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-start ${
                    selected && deploymentKey(selected) === deploymentKey(event.deployment)
                      ? 'border-info-line bg-info-soft'
                      : 'border-line bg-surface hover:border-line-strong'
                  }`}
                >
                  <span className="text-xs font-semibold uppercase tracking-wide text-info">
                    Deployment
                  </span>
                  <span className="min-w-0">
                    <span className="block break-words font-medium text-ink">
                      {event.deployment.service ?? event.deployment.repo}
                    </span>
                    <span className="block break-words text-xs text-ink-muted">
                      {event.deployment.status} · {event.deployment.source} ·{' '}
                      {event.deployment.revisions?.[0] ?? event.deployment.sha}
                    </span>
                  </span>
                  <time
                    dateTime={event.at}
                    title={formatAbsoluteTime(event.at)}
                    className="text-xs text-ink-muted"
                  >
                    {relativeTime(event.at, now)}
                  </time>
                </button>
              </li>
            ) : (
              <li
                key={`incident-${event.incident.id}`}
                className="grid min-w-0 gap-2 rounded-lg border border-critical-line bg-critical-soft p-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-start"
              >
                <span className="text-xs font-semibold uppercase tracking-wide text-critical">
                  Incident
                </span>
                <span className="min-w-0">
                  <Link
                    to={incidentPath(event.incident.id)}
                    className="block break-words font-medium text-critical hover:underline"
                  >
                    {incidentDisplayTitle(event.incident)}
                  </Link>
                  <span className="block text-xs text-critical">
                    {event.incident.severity} · {event.incident.status} · {event.incident.service}
                  </span>
                </span>
                <time
                  dateTime={event.at}
                  title={formatAbsoluteTime(event.at)}
                  className="text-xs text-critical"
                >
                  {relativeTime(event.at, now)}
                </time>
              </li>
            ),
          )}
        </ol>

        <aside
          aria-label="Selected deployment evidence"
          className="h-fit rounded-lg border border-line bg-surface p-4 xl:sticky xl:top-4"
        >
          {!selected ? (
            <p className="text-sm text-ink-muted">
              Select a deployment to inspect its provider evidence and related incidents.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    Selected deployment
                  </p>
                  <h3 className="break-words text-lg font-semibold text-ink">
                    {selected.service ?? selected.repo}
                  </h3>
                </div>
                <span className="rounded bg-surface-strong px-2 py-1 text-xs font-medium text-ink-secondary">
                  {selected.status}
                </span>
              </div>

              <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Service</dt>
                  <dd className="break-words text-ink">{selected.service ?? 'Unmapped'}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Environment</dt>
                  <dd className="break-words text-ink">
                    {selected.environment ?? 'Unavailable from source'}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Provider target</dt>
                  <dd className="break-words text-ink">{selected.repo}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Source</dt>
                  <dd className="text-ink">{selected.source}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Deployed</dt>
                  <dd className="text-ink">{formatAbsoluteTime(selected.deployedAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-ink-muted">Actor</dt>
                  <dd className="break-words text-ink">{selected.actor ?? 'Not reported'}</dd>
                </div>
                <div className="sm:col-span-2 xl:col-span-1 2xl:col-span-2">
                  <dt className="text-xs font-medium text-ink-muted">Revision evidence</dt>
                  <dd className="break-all font-instrument text-xs text-ink">
                    {selected.revisions?.join(', ') || selected.sha}
                  </dd>
                </div>
              </dl>

              {application && (
                <div className="mt-4 rounded-md bg-surface-subtle p-3 text-sm text-ink-secondary">
                  <p className="font-medium text-ink">Current GitOps state</p>
                  <p>
                    Sync {application.syncStatus ?? 'unknown'} · Health{' '}
                    {application.healthStatus ?? 'unknown'} · Observed{' '}
                    {formatAbsoluteTime(application.observedAt)}
                  </p>
                </div>
              )}

              <div className="mt-4">
                <h4 className="text-sm font-semibold text-ink">Related incidents</h4>
                {related.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-muted">
                    No incident in the recent set shares this service within 24 hours.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-2">
                    {related.map((incident) => (
                      <li key={incident.id}>
                        <Link
                          to={incidentPath(incident.id)}
                          className="text-sm font-medium text-info hover:underline"
                        >
                          {incidentDisplayTitle(incident)}
                        </Link>
                        <p className="text-xs text-ink-muted">
                          {incident.severity} · {incident.status} ·{' '}
                          {formatAbsoluteTime(incident.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="mt-4 rounded-md border border-line p-3 text-sm text-ink-secondary">
                <p className="font-medium text-ink">Impact evidence</p>
                <p className="mt-1">
                  No before/after golden-signal comparison is available for this deployment. The
                  platform does not infer impact from deployment proximity alone.
                </p>
              </div>

              {isHttpUrl(selected.url) && (
                <a
                  href={selected.url}
                  className="mt-4 inline-flex rounded-md border border-line-strong px-3 py-2 text-sm font-medium text-info hover:bg-surface-subtle"
                >
                  Open provider evidence
                </a>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
