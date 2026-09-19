import {
  ReliabilityMetricRow,
  ReliabilitySummaryMetric,
  reliabilityFormat,
} from './ReliabilityMetrics';

export interface ReliabilityReport {
  period: {
    kind: string;
    current: { start: string | Date; end: string | Date };
    previous: { start: string | Date; end: string | Date };
    comparison: {
      current: { start: string | Date; end: string | Date };
      previous: { start: string | Date; end: string | Date };
      asOf: string | Date;
    };
  };
  outages: {
    signalCoverage: {
      retainedFrom: string | Date | null;
      measurementStartedAt: string | Date | null;
      currentComplete: boolean;
      previousComplete: boolean;
    };
    current: OutageSummary;
    previous: OutageSummary;
    ticketFlow: {
      current: TicketFlow;
      previous: TicketFlow;
      definitions: { promotionRate: string; age: string };
    };
    byService: readonly {
      service: string;
      currentIncidents: number;
      previousIncidents: number;
      currentAlerts: number;
      previousAlerts: number;
      currentAlertsPerIncident: number | null;
      previousAlertsPerIncident: number | null;
    }[];
    byServiceNextCursor: string | null;
    topCauses: readonly { tag: string; incidentCount: number }[];
    topCausesTruncated: boolean;
    topCauseCaveat: string;
  };
  toil: {
    created: {
      approvalDemands: number;
      clarificationRequests: number;
      degradedReasks: number;
      findingCorrections: number;
    };
    removed: {
      averageFirstHypothesisSeconds: number | null;
      humanTurnsPerProviderIncident: Ratio;
      citedRunbookAdoption: Rate;
      resolvedWithoutResponderOrApprovedAction: Rate;
    };
    definitions: readonly string[];
  };
}

interface Ratio {
  numerator: number;
  denominator: number;
  value: number | null;
}
interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}
interface OutageSummary {
  incidentCount: number;
  alertCount: number;
  alertsPerIncident: Ratio & { alertDefinition: string; incidentDefinition: string };
}
interface TicketFlow {
  ticketCount: number;
  promotedCount: number;
  promotionRate: number | null;
  averagePromotionAgeSeconds: number | null;
  averageOpenAgeSeconds: number | null;
}

/** Presents reliability load and toil from the shared period DTO. */
export function ReliabilityReportView(props: {
  report: ReliabilityReport;
  mode: 'dashboard' | 'weekly';
}) {
  const { report } = props;
  const minutes =
    report.toil.removed.averageFirstHypothesisSeconds === null
      ? null
      : Math.round(report.toil.removed.averageFirstHypothesisSeconds / 60);
  const incompleteCoverage =
    !report.outages.signalCoverage.currentComplete ||
    !report.outages.signalCoverage.previousComplete;

  return (
    <section
      aria-label={props.mode === 'weekly' ? 'Weekly reliability report data' : 'Reliability data'}
      className="space-y-6"
    >
      <section aria-labelledby="reliability-load-title" className="space-y-4">
        <div>
          <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-accent">
            Equal elapsed UTC comparison
          </p>
          <h2 id="reliability-load-title" className="mt-1 text-lg font-medium tracking-tight">
            Reliability load
          </h2>
          <p className="mt-1 text-sm leading-6 text-ink-muted">
            Current: {reliabilityFormat.range(report.period.comparison.current)}. Previous:{' '}
            {reliabilityFormat.range(report.period.comparison.previous)}.
          </p>
        </div>

        {incompleteCoverage && (
          <div className="rounded-lg border border-warning-line bg-warning-soft px-4 py-3 text-sm leading-6 text-warning">
            <strong>Signal ratios have incomplete coverage.</strong>{' '}
            {report.outages.signalCoverage.retainedFrom
              ? `Retained signal history begins ${reliabilityFormat.utc(report.outages.signalCoverage.retainedFrom)}.`
              : 'Signal measurement has not started.'}
          </div>
        )}

        <dl
          aria-label="Reliability load summary"
          className="grid overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3 sm:gap-px"
        >
          <ReliabilitySummaryMetric
            label="Incidents opened"
            value={reliabilityFormat.integer(report.outages.current.incidentCount)}
            previous={reliabilityFormat.integer(report.outages.previous.incidentCount)}
            detail={report.outages.current.alertsPerIncident.incidentDefinition}
          />
          <ReliabilitySummaryMetric
            label="Classified signals"
            value={reliabilityFormat.integer(report.outages.current.alertCount)}
            previous={reliabilityFormat.integer(report.outages.previous.alertCount)}
            detail={report.outages.current.alertsPerIncident.alertDefinition}
          />
          <ReliabilitySummaryMetric
            label="Signals per incident"
            value={reliabilityFormat.decimal(report.outages.current.alertsPerIncident.value)}
            previous={reliabilityFormat.decimal(report.outages.previous.alertsPerIncident.value)}
            detail="Signal-to-incident concentration for the measured period."
          />
        </dl>

        <section aria-label="Outage load" className="rounded-xl border border-line bg-surface">
          <div className="border-b border-line px-4 py-4 sm:px-5">
            <h3 className="font-medium text-ink">Reliability by service</h3>
            <p className="mt-1 text-sm text-ink-muted">
              Current period-to-date beside the same elapsed part of the previous period.
            </p>
          </div>
          {report.outages.byService.length === 0 ? (
            <p className="px-5 py-8 text-sm text-ink-muted">No service activity in this period.</p>
          ) : (
            <>
              <ul
                aria-label="Reliability by service summary"
                className="divide-y divide-line sm:hidden"
              >
                {report.outages.byService.map((row) => (
                  <li key={row.service} className="p-4">
                    <h4 className="truncate text-sm font-semibold text-ink" title={row.service}>
                      {row.service}
                    </h4>
                    <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3">
                      <div>
                        <dt className="text-xs text-ink-muted">Incidents</dt>
                        <dd className="mt-1 font-instrument text-sm font-semibold tabular-nums">
                          {row.currentIncidents}{' '}
                          <span className="font-normal text-ink-faint">
                            / {row.previousIncidents} prior
                          </span>
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-ink-muted">Signals</dt>
                        <dd className="mt-1 font-instrument text-sm font-semibold tabular-nums">
                          {row.currentAlerts}{' '}
                          <span className="font-normal text-ink-faint">
                            / {row.previousAlerts} prior
                          </span>
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-xs text-ink-muted">Signals per incident</dt>
                        <dd className="mt-1 font-instrument text-sm font-semibold tabular-nums">
                          {reliabilityFormat.decimal(row.currentAlertsPerIncident)}{' '}
                          <span className="font-normal text-ink-faint">
                            / {reliabilityFormat.decimal(row.previousAlertsPerIncident)} prior
                          </span>
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>
              <div
                data-responsive-table="reliability-by-service"
                className="hidden overflow-x-auto sm:block"
              >
                <table aria-label="Reliability by service" className="w-full min-w-[58rem] text-sm">
                  <thead className="bg-surface-subtle text-left text-xs font-semibold text-ink-secondary">
                    <tr>
                      <th
                        scope="col"
                        className="sticky left-0 z-10 bg-surface-subtle px-4 py-3 sm:px-5"
                      >
                        Service
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Current incidents
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Previous incidents
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Current signals
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Previous signals
                      </th>
                      <th scope="col" className="px-3 py-3 text-right">
                        Current signals/incident
                      </th>
                      <th scope="col" className="px-4 py-3 text-right sm:px-5">
                        Previous signals/incident
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.outages.byService.map((row) => (
                      <tr key={row.service} className="border-t border-line first:border-t-0">
                        <th
                          scope="row"
                          className="sticky left-0 z-10 max-w-64 bg-surface px-4 py-3 text-left font-medium text-ink sm:px-5"
                        >
                          <span className="block truncate" title={row.service}>
                            {row.service}
                          </span>
                        </th>
                        <td className="px-3 py-3 text-right font-instrument tabular-nums">
                          {row.currentIncidents}
                        </td>
                        <td className="px-3 py-3 text-right font-instrument tabular-nums text-ink-muted">
                          {row.previousIncidents}
                        </td>
                        <td className="px-3 py-3 text-right font-instrument tabular-nums">
                          {row.currentAlerts}
                        </td>
                        <td className="px-3 py-3 text-right font-instrument tabular-nums text-ink-muted">
                          {row.previousAlerts}
                        </td>
                        <td className="px-3 py-3 text-right font-instrument tabular-nums">
                          {reliabilityFormat.decimal(row.currentAlertsPerIncident)}
                        </td>
                        <td className="px-4 py-3 text-right font-instrument tabular-nums text-ink-muted sm:px-5">
                          {reliabilityFormat.decimal(row.previousAlertsPerIncident)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-2">
        <section
          aria-labelledby="ticket-flow-title"
          className="rounded-xl border border-line bg-surface p-4 sm:p-5"
        >
          <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-accent">
            Signal control
          </p>
          <h3 id="ticket-flow-title" className="mt-1 font-medium text-ink">
            Ticket flow
          </h3>
          <p className="mt-3 text-2xl font-semibold tracking-tight text-ink">
            {report.outages.ticketFlow.current.promotedCount} of{' '}
            {report.outages.ticketFlow.current.ticketCount} promoted{' '}
            <span className="text-base font-medium text-ink-muted">
              ({reliabilityFormat.percentage(report.outages.ticketFlow.current.promotionRate)})
            </span>
          </p>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            {report.outages.ticketFlow.definitions.promotionRate}
          </p>
          <dl className="mt-4">
            <ReliabilityMetricRow
              label="Mean time to promotion"
              value={reliabilityFormat.age(
                report.outages.ticketFlow.current.averagePromotionAgeSeconds,
              )}
              detail={`Previous: ${reliabilityFormat.age(report.outages.ticketFlow.previous.averagePromotionAgeSeconds)}`}
            />
            <ReliabilityMetricRow
              label="Mean age while unpromoted"
              value={reliabilityFormat.age(report.outages.ticketFlow.current.averageOpenAgeSeconds)}
              detail={`Previous: ${reliabilityFormat.age(report.outages.ticketFlow.previous.averageOpenAgeSeconds)}`}
            />
          </dl>
          <p className="mt-4 border-t border-line pt-3 text-xs leading-5 text-ink-muted">
            {report.outages.ticketFlow.definitions.age}
          </p>
        </section>

        <section
          aria-labelledby="top-causes-title"
          className="rounded-xl border border-line bg-surface p-4 sm:p-5"
        >
          <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-accent">
            Accepted evidence
          </p>
          <h3 id="top-causes-title" className="mt-1 font-medium text-ink">
            Top causes
          </h3>
          {report.outages.topCauses.length === 0 ? (
            <p className="mt-4 rounded-lg bg-surface-subtle px-4 py-5 text-sm text-ink-muted">
              No accepted cause tags in this period.
            </p>
          ) : (
            <ol className="mt-4 space-y-2">
              {report.outages.topCauses.map((cause, index) => (
                <li
                  key={cause.tag}
                  className="flex items-center gap-3 rounded-lg bg-surface-subtle px-3 py-2.5"
                >
                  <span className="font-instrument text-xs text-ink-faint">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span
                    className="min-w-0 flex-1 truncate text-sm font-medium text-ink"
                    title={cause.tag}
                  >
                    {cause.tag}
                  </span>
                  <span className="font-instrument text-sm font-semibold tabular-nums text-ink-secondary">
                    {cause.incidentCount}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {report.outages.topCausesTruncated && (
            <p className="mt-3 text-xs text-ink-muted">
              Additional cause tags fall outside this ranked view.
            </p>
          )}
          <p className="mt-4 border-t border-line pt-3 text-xs leading-5 text-ink-muted">
            {report.outages.topCauseCaveat}
          </p>
        </section>
      </div>

      <section aria-label="Toil balance" aria-labelledby="toil-balance-title">
        <div className="mb-3">
          <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-accent">
            Responder efficiency
          </p>
          <h2 id="toil-balance-title" className="mt-1 text-lg font-medium tracking-tight">
            Human toil
          </h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <section
            aria-labelledby="toil-created-title"
            className="rounded-xl border border-line bg-surface p-4 sm:p-5"
          >
            <h3 id="toil-created-title" className="font-medium text-ink">
              Toil created
            </h3>
            <dl className="mt-4">
              <ReliabilityMetricRow
                label="Approval demands"
                value={reliabilityFormat.integer(report.toil.created.approvalDemands)}
              />
              <ReliabilityMetricRow
                label="Clarification requests"
                value={reliabilityFormat.integer(report.toil.created.clarificationRequests)}
              />
              <ReliabilityMetricRow
                label="Degraded re-asks"
                value={reliabilityFormat.integer(report.toil.created.degradedReasks)}
              />
              <ReliabilityMetricRow
                label="Finding corrections"
                value={reliabilityFormat.integer(report.toil.created.findingCorrections)}
              />
            </dl>
          </section>
          <section
            aria-labelledby="toil-removed-title"
            className="rounded-xl border border-line bg-surface p-4 sm:p-5"
          >
            <h3 id="toil-removed-title" className="font-medium text-ink">
              Toil removed
            </h3>
            <dl className="mt-4">
              <ReliabilityMetricRow
                label="Time to first hypothesis"
                value={minutes === null ? 'No data' : `${minutes} min`}
              />
              <ReliabilityMetricRow
                label="Responder turns"
                value={reliabilityFormat.integer(
                  report.toil.removed.humanTurnsPerProviderIncident.numerator,
                )}
                detail={`Across ${reliabilityFormat.quantity(report.toil.removed.humanTurnsPerProviderIncident.denominator, 'provider incident')}`}
              />
              <ReliabilityMetricRow
                label="Cited runbook adoption"
                value={reliabilityFormat.percentage(report.toil.removed.citedRunbookAdoption.rate)}
              />
              <ReliabilityMetricRow
                label="Resolved without responder or approved action"
                value={reliabilityFormat.percentage(
                  report.toil.removed.resolvedWithoutResponderOrApprovedAction.rate,
                )}
              />
            </dl>
          </section>
        </div>
        {report.toil.definitions.length > 0 && (
          <details className="mt-3 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            <summary className="cursor-pointer font-medium text-ink-secondary">
              Metric definitions
            </summary>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-ink-muted">
              {report.toil.definitions.map((definition) => (
                <li key={definition}>{definition}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </section>
  );
}
