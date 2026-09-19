import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../auth';
import { config } from '../config';
import { infrastructureHealth } from '../lib/infrastructure';
import { productPath } from '../lib/routes';
import { useMe } from '../lib/me-store';
import { useChanges } from '../lib/useChanges';
import { useConnectors } from '../lib/useConnectors';
import { useDeployments } from '../lib/useDeployments';
import { useIncidents } from '../lib/useIncidents';
import { useInfrastructure } from '../lib/useInfrastructure';
import {
  CHANGE_WINDOW_MS,
  CorrelatedChanges,
  DASHBOARD_ROW_LIMIT,
  HEALTH_ORDER,
  IncidentQueue,
  InfrastructureExceptions,
  OPEN_QUEUE_LIMIT,
  SectionHeader,
  connectorIssue,
} from './DashboardSections';
import { relatedIncidentsFor } from './DeploymentEvidenceTimeline';
import { IncidentFreeStatusRail } from './IncidentFreeStatus';
import { SkeletonBlock, SkeletonRows } from './LoadingSkeleton';
import { OperationalBand } from './OperationalBand';
import { PageHeader } from './PageHeader';
import { InlineAlert } from './PageState';
import { WorkspaceChecklist, workspaceChecklistComplete } from '../onboarding/WorkspaceChecklist';

export function DashboardPanel() {
  const session = useSession();
  const { getCredentials } = session;
  const me = useMe(getCredentials, session.status === 'authenticated', session.sessionKey);
  const changeWindowStart = useMemo(
    () => new Date(Date.now() - CHANGE_WINDOW_MS).toISOString(),
    [],
  );
  const incidentState = useIncidents({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    state: 'open',
    limit: OPEN_QUEUE_LIMIT,
    pollMs: 30_000,
  });
  const infrastructureState = useInfrastructure({ apiBaseUrl: config.apiBaseUrl, getCredentials });
  const deploymentState = useDeployments({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    limit: 50,
    filters: { from: changeWindowStart },
  });
  const changeState = useChanges({
    apiBaseUrl: config.apiBaseUrl,
    getCredentials,
    limit: 1,
    filters: { from: changeWindowStart },
  });
  const connectorState = useConnectors({ apiBaseUrl: config.apiBaseUrl, getCredentials });

  const operationalCounts = incidentState.operationalCounts ?? incidentState.counts;
  const openTotal =
    operationalCounts?.open ??
    incidentState.incidents.filter((incident) => incident.purpose !== 'health_check').length;
  const needsHuman =
    incidentState.counts?.needsHuman ??
    incidentState.incidents.filter((incident) => incident.requiresHumanAttention).length;
  const automationHandling =
    incidentState.counts?.automation ??
    incidentState.incidents.filter((incident) => !incident.requiresHumanAttention).length;
  const connectorGaps = connectorState.connectors.flatMap((connector) => {
    const issue = connectorIssue(connector);
    return issue ? [{ connector, issue }] : [];
  });
  const infrastructureExceptions = infrastructureState.snapshots
    .map((snapshot) => ({ snapshot, health: infrastructureHealth(snapshot, Date.now()) }))
    .filter((row) => row.health !== 'healthy')
    .sort(
      (left, right) =>
        HEALTH_ORDER[left.health] - HEALTH_ORDER[right.health] ||
        Date.parse(right.snapshot.observedAt) - Date.parse(left.snapshot.observedAt),
    );
  const correlatedDeployments = deploymentState.deployments
    .map((deployment) => ({
      deployment,
      incidents: relatedIncidentsFor(deployment, incidentState.incidents),
    }))
    .filter((row) => row.incidents.length > 0);
  const incidentSummaryUnavailable = incidentState.error && incidentState.incidents.length === 0;
  const connectorSummaryUnavailable =
    connectorState.error && connectorState.connectors.length === 0;
  const incidentInitialLoading = incidentState.loading && incidentState.counts == null;
  const connectorInitialLoading = connectorState.loading && connectorState.connectors.length === 0;
  const noEvidenceSourcesConfigured =
    !connectorSummaryUnavailable &&
    !connectorInitialLoading &&
    connectorState.connectors.length === 0;
  const dashboardLoading =
    incidentInitialLoading ||
    (infrastructureState.loading && infrastructureState.snapshots.length === 0) ||
    (deploymentState.loading && deploymentState.deployments.length === 0) ||
    (changeState.loading && changeState.changes.length === 0) ||
    (connectorState.loading && connectorState.connectors.length === 0);
  const incidentFacetLabel = incidentSummaryUnavailable
    ? 'Incident summary unavailable'
    : openTotal > 0
      ? `${openTotal} active incidents`
      : 'No active incidents';
  const connectorFacetLabel = connectorInitialLoading
    ? 'Loading evidence source status'
    : connectorSummaryUnavailable
      ? 'Evidence source status unavailable'
      : noEvidenceSourcesConfigured
        ? 'No evidence sources configured'
        : connectorGaps.length > 0
          ? `${connectorGaps.length} evidence blind spots`
          : 'Evidence sources healthy';
  const ownershipFacetLabel = incidentSummaryUnavailable
    ? 'Response ownership unavailable'
    : needsHuman + automationHandling === 0
      ? 'No active response ownership'
      : needsHuman > 0
        ? `${needsHuman} need human attention`
        : 'Automation owns response';

  return (
    <section>
      <PageHeader
        title="Operational dashboard"
        description="The active response picture: work needing ownership, evidence exceptions, nearby changes, and diagnostic blind spots."
        action={
          <Link to={productPath('incidents')} className="sre-action sre-action-primary">
            Open incident queue
          </Link>
        }
      />

      {me.data?.welcome &&
        !me.data.welcome.dismissed &&
        !workspaceChecklistComplete(me.data.welcome) && (
          <div className="mb-6 rounded-xl border border-line bg-surface p-4 sm:p-6">
            <WorkspaceChecklist
              checklist={me.data.welcome}
              domainId={me.data.domain?.id}
              onRefresh={me.refresh}
            />
          </div>
        )}

      <p role="status" aria-live="polite" className="sr-only">
        {dashboardLoading ? 'Loading operational dashboard…' : ''}
      </p>

      <div className="mb-6">
        <OperationalBand
          eyebrow="Response now"
          title="Operational pressure"
          description="The queue is ordered by response priority. State colors identify exceptions, not decoration."
          facets={[
            {
              label: incidentFacetLabel,
              tone: incidentSummaryUnavailable ? 'unknown' : openTotal > 0 ? 'critical' : 'success',
            },
            {
              label: connectorFacetLabel,
              tone:
                connectorInitialLoading || connectorSummaryUnavailable
                  ? 'unknown'
                  : noEvidenceSourcesConfigured || connectorGaps.length > 0
                    ? 'warning'
                    : 'success',
            },
            {
              label: ownershipFacetLabel,
              tone: incidentSummaryUnavailable ? 'unknown' : needsHuman > 0 ? 'warning' : 'info',
            },
          ]}
          metrics={[
            {
              label: 'Active',
              value: incidentInitialLoading ? (
                <SkeletonBlock className="h-7 w-12" />
              ) : incidentSummaryUnavailable ? (
                '—'
              ) : (
                openTotal
              ),
              detail: 'Non-terminal incidents',
              tone: incidentSummaryUnavailable ? 'unknown' : openTotal > 0 ? 'critical' : 'success',
              href: productPath('incidents'),
            },
            {
              label: 'Human decisions',
              value: incidentInitialLoading ? (
                <SkeletonBlock className="h-7 w-12" />
              ) : incidentSummaryUnavailable ? (
                '—'
              ) : (
                needsHuman
              ),
              detail: 'Judgment or authority required',
              tone: incidentSummaryUnavailable ? 'unknown' : needsHuman > 0 ? 'warning' : 'success',
              href: productPath('incidents'),
            },
            {
              label: 'Automation',
              value: incidentInitialLoading ? (
                <SkeletonBlock className="h-7 w-12" />
              ) : incidentSummaryUnavailable ? (
                '—'
              ) : (
                automationHandling
              ),
              detail: 'Investigations in progress',
              tone: incidentSummaryUnavailable ? 'unknown' : 'info',
              href: productPath('incidents'),
            },
            {
              label: 'Blind spots',
              value: connectorInitialLoading ? (
                <SkeletonBlock className="h-7 w-12" />
              ) : connectorSummaryUnavailable ? (
                '—'
              ) : noEvidenceSourcesConfigured ? (
                'Not configured'
              ) : (
                connectorGaps.length
              ),
              detail: 'Connector coverage gaps',
              tone:
                connectorInitialLoading || connectorSummaryUnavailable
                  ? 'unknown'
                  : noEvidenceSourcesConfigured || connectorGaps.length > 0
                    ? 'warning'
                    : 'success',
              href: productPath('connectors'),
            },
          ]}
          statusRail={
            <IncidentFreeStatusRail
              status={incidentState.incidentFreeStatus}
              loading={incidentInitialLoading}
            />
          }
        />
      </div>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(22rem,1fr)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="dashboard-incidents-title">
            <SectionHeader
              id="dashboard-incidents-title"
              title="Needs attention now"
              description="Highest-priority active work, in the order supplied by the incident API."
              href={productPath('incidents')}
              linkLabel="View all incidents"
            />
            {incidentState.error && !incidentState.backgroundError && (
              <InlineAlert message="The active incident queue is unavailable." />
            )}
            {incidentState.backgroundError && (
              <InlineAlert message="Incident refresh failed; showing the last successful response." />
            )}
            {incidentState.error &&
            !incidentState.backgroundError &&
            incidentState.incidents.length === 0 ? null : incidentState.loading &&
              incidentState.incidents.length === 0 ? (
              <SkeletonRows label="Loading active incidents…" rows={3} announce={false} />
            ) : (
              <IncidentQueue incidents={incidentState.incidents} />
            )}
          </section>

          <section aria-labelledby="dashboard-infrastructure-title">
            <SectionHeader
              id="dashboard-infrastructure-title"
              title="Operational exceptions"
              description={`${infrastructureExceptions.length} unhealthy, stale, or attention-required observations. Healthy resources stay collapsed.`}
              href={productPath('infrastructure')}
              linkLabel="Open infrastructure"
            />
            {infrastructureState.error && !infrastructureState.backgroundError && (
              <InlineAlert message="Infrastructure evidence is unavailable." />
            )}
            {infrastructureState.backgroundError && (
              <InlineAlert message="Infrastructure refresh failed; showing the last successful observations." />
            )}
            {infrastructureState.error &&
            !infrastructureState.backgroundError &&
            infrastructureState.snapshots.length === 0 ? null : infrastructureState.loading &&
              infrastructureState.snapshots.length === 0 ? (
              <SkeletonRows label="Loading infrastructure evidence…" rows={3} announce={false} />
            ) : (
              <InfrastructureExceptions rows={infrastructureExceptions} />
            )}
          </section>
        </div>

        <div className="min-w-0 space-y-6">
          <section aria-labelledby="dashboard-changes-title">
            <SectionHeader
              id="dashboard-changes-title"
              title="Changes near active incidents"
              description="Same-service deployments within 24 hours. Proximity is evidence, not proof of causality."
              href={productPath('deployments')}
              linkLabel="Open deployments"
            />
            {(deploymentState.error || changeState.error) && (
              <InlineAlert message="Some recent change evidence is unavailable." />
            )}
            {deploymentState.error &&
            correlatedDeployments.length === 0 ? null : (deploymentState.loading ||
                changeState.loading) &&
              correlatedDeployments.length === 0 ? (
              <SkeletonRows label="Loading recent change evidence…" rows={3} announce={false} />
            ) : (
              <CorrelatedChanges rows={correlatedDeployments} />
            )}
            {!changeState.loading && !changeState.error && (
              <p className="mt-2 text-xs text-ink-muted">
                Change feed: {changeState.summary.failing} failing CI event
                {changeState.summary.failing === 1 ? '' : 's'} in the last 24 hours.{' '}
                <Link
                  to={productPath('changes')}
                  className="font-semibold text-accent hover:text-info"
                >
                  Inspect source changes →
                </Link>
              </p>
            )}
          </section>

          <section aria-labelledby="dashboard-coverage-title">
            <SectionHeader
              id="dashboard-coverage-title"
              title="Diagnostic coverage"
              description="Only evidence sources that reduce investigator confidence are expanded."
              href={productPath('connectors')}
              linkLabel="Manage connectors"
            />
            {connectorState.error && <InlineAlert message="Connector health is unavailable." />}
            {connectorState.error &&
            connectorState.connectors.length === 0 ? null : connectorInitialLoading ? (
              <SkeletonRows label="Loading diagnostic coverage…" rows={3} announce={false} />
            ) : connectorState.connectors.length === 0 ? (
              <p className="rounded-md bg-warning-soft p-4 text-sm text-warning">
                No evidence sources are configured. Investigations cannot inspect live systems.
              </p>
            ) : connectorGaps.length === 0 ? (
              <p className="rounded-md bg-success-soft p-4 text-sm text-success">
                No connector blind spots are currently reported.
              </p>
            ) : (
              <ul className="space-y-2" aria-label="Connector blind spots">
                {connectorGaps.slice(0, DASHBOARD_ROW_LIMIT).map(({ connector, issue }) => (
                  <li
                    key={connector.id}
                    className="rounded-lg border border-warning-line bg-warning-soft p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <strong className="break-words text-warning">{connector.name}</strong>
                      <span className="rounded-full bg-warning-muted px-2 py-0.5 text-xs font-semibold text-warning">
                        {issue}
                      </span>
                    </div>
                    <p className="mt-1 text-xs uppercase tracking-wide text-warning">
                      {connector.type}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
