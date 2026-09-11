import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { runbookCitedPredicate } from './reliability-predicates';
import { withTenant } from './rls';
import { getTenantSignalPolicy } from './signal-policy-repo';

export type ReliabilityPeriod = 'week' | 'month' | 'quarter';

export interface ReliabilityPeriodBounds {
  current: { start: Date; end: Date };
  previous: { start: Date; end: Date };
}

export interface ReliabilityReportOptions {
  period: ReliabilityPeriod;
  now?: Date;
  serviceAfter?: string;
  serviceLimit?: number;
}

const utc = (year: number, month: number, day: number): Date =>
  new Date(Date.UTC(year, month, day));

/**
 * Computes adjacent UTC calendar periods for reliability comparisons.
 * @param period - UTC calendar period kind.
 * @param now - Clock used to select the current period.
 */
export function reliabilityPeriodBounds(
  period: ReliabilityPeriod,
  now: Date = new Date(),
): ReliabilityPeriodBounds {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const day = now.getUTCDate();
  if (period === 'week') {
    const mondayOffset = now.getUTCDay() === 0 ? 6 : now.getUTCDay() - 1;
    const currentStart = utc(year, month, day - mondayOffset);
    return {
      current: { start: currentStart, end: new Date(currentStart.getTime() + 604_800_000) },
      previous: { start: new Date(currentStart.getTime() - 604_800_000), end: currentStart },
    };
  }
  if (period === 'month') {
    const currentStart = utc(year, month, 1);
    return {
      current: { start: currentStart, end: utc(year, month + 1, 1) },
      previous: { start: utc(year, month - 1, 1), end: currentStart },
    };
  }
  const quarterMonth = Math.floor(month / 3) * 3;
  const currentStart = utc(year, quarterMonth, 1);
  return {
    current: { start: currentStart, end: utc(year, quarterMonth + 3, 1) },
    previous: { start: utc(year, quarterMonth - 3, 1), end: currentStart },
  };
}

const number = (value: unknown): number => Number(value ?? 0);
const nullableNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

interface IncidentAggregate extends Record<string, unknown> {
  currentCount: number;
  previousCount: number;
}

interface SignalAggregate extends Record<string, unknown> {
  currentAlerts: number;
  previousAlerts: number;
  currentTickets: number;
  previousTickets: number;
  currentPromoted: number;
  previousPromoted: number;
  currentPromotionAge: number | null;
  previousPromotionAge: number | null;
  currentOpenAge: number | null;
  previousOpenAge: number | null;
}

interface ToilAggregate extends Record<string, unknown> {
  approvalDemands: number;
  clarificationRequests: number;
  degradedReasks: number;
  findingCorrections: number;
  providerIncidents: number;
  humanTurns: number;
  unattendedResolved: number;
  averageFirstHypothesisSeconds: number | null;
  trustedRuns: number;
  adoptedRuns: number;
}

/**
 * Builds a bounded tenant reliability and toil read model using database aggregates.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param options - Period and optional clock.
 */
export function readReliabilityReport(db: Db, tenantId: string, options: ReliabilityReportOptions) {
  const bounds = reliabilityPeriodBounds(options.period, options.now);
  const now = options.now ?? new Date();
  const currentObservedEnd = new Date(Math.min(now.getTime(), bounds.current.end.getTime()));
  const observedDuration = currentObservedEnd.getTime() - bounds.current.start.getTime();
  const previousObservedEnd = new Date(bounds.previous.start.getTime() + observedDuration);
  const currentStart = bounds.current.start.toISOString();
  const currentEnd = currentObservedEnd.toISOString();
  const previousStart = bounds.previous.start.toISOString();
  const previousEnd = previousObservedEnd.toISOString();
  const asOf = now.toISOString();
  const previousAsOf = previousObservedEnd.toISOString();
  const serviceAfter = options.serviceAfter ?? null;
  const serviceLimit = Math.max(1, Math.min(100, Math.trunc(options.serviceLimit ?? 50)));
  return getTenantSignalPolicy(db, tenantId).then((policy) =>
    withTenant(db, tenantId, async (tx) => {
      const retentionStart = new Date(now.getTime() - policy.retentionDays * 86_400_000);
      const retainedFrom = policy.measurementStartedAt
        ? policy.measurementStartedAt > retentionStart
          ? policy.measurementStartedAt
          : retentionStart
        : null;
      const currentSignalCoverageComplete =
        retainedFrom !== null && retainedFrom <= bounds.current.start;
      const previousSignalCoverageComplete =
        retainedFrom !== null && retainedFrom <= bounds.previous.start;
      const incidentResult = await tx.execute<IncidentAggregate>(sql`
      select
        count(*) filter (
          where created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        )::int as "currentCount",
        count(*) filter (
          where created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        )::int as "previousCount"
      from incidents
      where archived_at is null and purpose = 'incident'
        and created_at >= ${previousStart}::timestamptz
        and created_at < ${currentEnd}::timestamptz
    `);
      const incidents = incidentResult[0] ?? { currentCount: 0, previousCount: 0 };

      const serviceResult = await tx.execute<{
        service: string;
        currentIncidents: number;
        previousIncidents: number;
        currentAlerts: number;
        previousAlerts: number;
      }>(sql`
      with service_keys as (
        select service from incidents
        where archived_at is null and purpose = 'incident'
          and ((created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz)
            or (created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz))
        union
        select coalesce(service, 'unknown') from signal_dispositions
        where (created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz)
          or (created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz)
      )
      select service_keys.service,
        (select count(*)::int from incidents item
          where item.archived_at is null and item.purpose = 'incident' and item.service = service_keys.service
            and item.created_at >= ${currentStart}::timestamptz and item.created_at < ${currentEnd}::timestamptz
        ) as "currentIncidents",
        (select count(*)::int from incidents item
          where item.archived_at is null and item.purpose = 'incident' and item.service = service_keys.service
            and item.created_at >= ${previousStart}::timestamptz and item.created_at < ${previousEnd}::timestamptz
        ) as "previousIncidents",
        (select count(*)::int from signal_dispositions item
          where coalesce(item.service, 'unknown') = service_keys.service
            and item.created_at >= ${currentStart}::timestamptz and item.created_at < ${currentEnd}::timestamptz
        ) as "currentAlerts",
        (select count(*)::int from signal_dispositions item
          where coalesce(item.service, 'unknown') = service_keys.service
            and item.created_at >= ${previousStart}::timestamptz and item.created_at < ${previousEnd}::timestamptz
        ) as "previousAlerts"
      from service_keys
      where (${serviceAfter}::text is null or service_keys.service > ${serviceAfter}::text)
      order by service_keys.service
      limit ${serviceLimit + 1}
    `);

      const signalResult = await tx.execute<SignalAggregate>(sql`
      select
        count(*) filter (
          where created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        )::int as "currentAlerts",
        count(*) filter (
          where created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        )::int as "previousAlerts",
        count(*) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        )::int as "currentTickets",
        count(*) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        )::int as "previousTickets",
        count(*) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and promoted_at is not null and promoted_at <= ${asOf}::timestamptz
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        )::int as "currentPromoted",
        count(*) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket' and promoted_at is not null
            and promoted_at <= ${previousAsOf}::timestamptz
            and created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        )::int as "previousPromoted",
        avg(extract(epoch from (promoted_at - created_at))) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and promoted_at is not null and promoted_at <= ${asOf}::timestamptz
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        ) as "currentPromotionAge",
        avg(extract(epoch from (promoted_at - created_at))) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket' and promoted_at is not null
            and promoted_at <= ${previousAsOf}::timestamptz
            and created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        ) as "previousPromotionAge",
        avg(extract(epoch from (${asOf}::timestamptz - created_at))) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and (promoted_at is null or promoted_at > ${asOf}::timestamptz)
            and (resolved_at is null or resolved_at > ${asOf}::timestamptz)
            and (superseded_at is null or superseded_at > ${asOf}::timestamptz)
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
        ) as "currentOpenAge",
        avg(extract(epoch from (${previousAsOf}::timestamptz - created_at))) filter (
          where disposition = 'ticket' and classification_mode = 'enforce'
            and effective_disposition = 'ticket'
            and (promoted_at is null or promoted_at > ${previousAsOf}::timestamptz)
            and (resolved_at is null or resolved_at > ${previousAsOf}::timestamptz)
            and (superseded_at is null or superseded_at > ${previousAsOf}::timestamptz)
            and created_at >= ${previousStart}::timestamptz and created_at < ${previousEnd}::timestamptz
        ) as "previousOpenAge"
      from signal_dispositions
      where created_at >= ${previousStart}::timestamptz and created_at < ${currentEnd}::timestamptz
    `);
      const signals = signalResult[0] ?? {
        currentAlerts: 0,
        previousAlerts: 0,
        currentTickets: 0,
        previousTickets: 0,
        currentPromoted: 0,
        previousPromoted: 0,
        currentPromotionAge: null,
        previousPromotionAge: null,
        currentOpenAge: null,
        previousOpenAge: null,
      };

      const causeResult = await tx.execute<{ tag: string; incidentCount: number }>(sql`
      select tags.tag, count(distinct tags.incident_id)::int as "incidentCount"
      from incident_tags tags
      inner join incidents current on current.id = tags.incident_id
      where tags.tag like 'cause:%'
        and current.archived_at is null
        and current.purpose = 'incident'
        and current.created_at >= ${currentStart}::timestamptz
        and current.created_at < ${currentEnd}::timestamptz
      group by tags.tag
      order by count(distinct tags.incident_id) desc, tags.tag
      limit 21
    `);

      const toilResult = await tx.execute<ToilAggregate>(sql`
      with current_provider as (
        select id, status, created_at, trusted_assessment_run_id
        from incidents
        where archived_at is null and purpose = 'incident' and alert_source <> 'manual'
          and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz
      ), trusted as (
        select runs.id, runs.incident_id, runs.completed_at, runs.evidence_ids, current.created_at
        from current_provider current
        inner join investigation_runs runs on runs.id = current.trusted_assessment_run_id
      ), first_hypothesis as (
        select current.id as incident_id, current.created_at,
          min(runs.completed_at) as first_hypothesis_at
        from current_provider current
        inner join investigation_runs runs on runs.incident_id = current.id
        where runs.completed_at is not null
          and jsonb_typeof(runs.result -> 'rankedHypotheses') = 'array'
          and jsonb_array_length(runs.result -> 'rankedHypotheses') > 0
        group by current.id, current.created_at
      )
      select
        (select count(*) from approvals
          where created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz)::int
          as "approvalDemands",
        (select count(*) from incident_messages
          where kind = 'clarification_request'
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz)::int
          as "clarificationRequests",
        (select count(*) from incident_messages
          where kind = 'degraded_reask'
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz)::int
          as "degradedReasks",
        (select count(*) from incident_feedback
          where target_type = 'finding' and decision = 'correct'
            and created_at >= ${currentStart}::timestamptz and created_at < ${currentEnd}::timestamptz)::int
          as "findingCorrections",
        (select count(*) from current_provider)::int as "providerIncidents",
        (select count(*) from incident_messages messages
          inner join current_provider current on current.id = messages.incident_id
          where messages.author = 'human'
            and messages.created_at >= ${currentStart}::timestamptz
            and messages.created_at < ${currentEnd}::timestamptz)::int as "humanTurns",
        (select count(*) from current_provider current
          where current.status = 'resolved'
            and not exists (
              select 1 from incident_messages messages
              where messages.incident_id = current.id and messages.author = 'human'
                and messages.created_at >= ${currentStart}::timestamptz
                and messages.created_at < ${currentEnd}::timestamptz
            )
            and not exists (
              select 1 from approvals decisions
              where decisions.incident_id = current.id and decisions.decision is not null
                and decisions.created_at >= ${currentStart}::timestamptz
                and decisions.created_at < ${currentEnd}::timestamptz
            ))::int as "unattendedResolved",
        (select avg(extract(epoch from (first_hypothesis_at - created_at))) from first_hypothesis)
          as "averageFirstHypothesisSeconds",
        (select count(*) from trusted)::int as "trustedRuns",
        (select count(*) from trusted where ${runbookCitedPredicate('trusted')})::int as "adoptedRuns"
    `);
      const toil = toilResult[0] ?? {
        approvalDemands: 0,
        clarificationRequests: 0,
        degradedReasks: 0,
        findingCorrections: 0,
        providerIncidents: 0,
        humanTurns: 0,
        unattendedResolved: 0,
        averageFirstHypothesisSeconds: null,
        trustedRuns: 0,
        adoptedRuns: 0,
      };

      const ticketFlow = (
        ticketCountValue: unknown,
        promotedCountValue: unknown,
        promotionAge: unknown,
        openAge: unknown,
      ) => {
        const ticketCount = number(ticketCountValue);
        const promotedCount = number(promotedCountValue);
        return {
          ticketCount,
          promotedCount,
          promotionRate: ratio(promotedCount, ticketCount),
          averagePromotionAgeSeconds: nullableNumber(promotionAge),
          averageOpenAgeSeconds: nullableNumber(openAge),
        };
      };
      const currentIncidentCount = number(incidents.currentCount);
      const previousIncidentCount = number(incidents.previousCount);
      const currentAlertCount = number(signals.currentAlerts);
      const previousAlertCount = number(signals.previousAlerts);
      const providerIncidentCount = number(toil.providerIncidents);
      const humanTurns = number(toil.humanTurns);
      const trustedRuns = number(toil.trustedRuns);
      const adoptedRuns = number(toil.adoptedRuns);
      const unattendedResolved = number(toil.unattendedResolved);
      return {
        period: {
          kind: options.period,
          ...bounds,
          comparison: {
            current: { start: bounds.current.start, end: currentObservedEnd },
            previous: { start: bounds.previous.start, end: previousObservedEnd },
            asOf: now,
          },
        },
        outages: {
          signalCoverage: {
            retainedFrom,
            measurementStartedAt: policy.measurementStartedAt,
            currentComplete: currentSignalCoverageComplete,
            previousComplete: previousSignalCoverageComplete,
          },
          current: {
            incidentCount: currentIncidentCount,
            alertCount: currentAlertCount,
            alertsPerIncident: {
              value: currentSignalCoverageComplete
                ? ratio(currentAlertCount, currentIncidentCount)
                : null,
              numerator: currentAlertCount,
              denominator: currentIncidentCount,
              alertDefinition: 'terminal classified signal records',
              incidentDefinition: 'incidents opened in the UTC period',
            },
          },
          previous: {
            incidentCount: previousIncidentCount,
            alertCount: previousAlertCount,
            alertsPerIncident: {
              value: previousSignalCoverageComplete
                ? ratio(previousAlertCount, previousIncidentCount)
                : null,
              numerator: previousAlertCount,
              denominator: previousIncidentCount,
              alertDefinition: 'terminal classified signal records',
              incidentDefinition: 'incidents opened in the UTC period',
            },
          },
          ticketFlow: {
            current: ticketFlow(
              signals.currentTickets,
              signals.currentPromoted,
              signals.currentPromotionAge,
              signals.currentOpenAge,
            ),
            previous: ticketFlow(
              signals.previousTickets,
              signals.previousPromoted,
              signals.previousPromotionAge,
              signals.previousOpenAge,
            ),
            definitions: {
              promotionRate: 'tickets created in the UTC period that were promoted to an incident',
              age: 'mean seconds from ticket creation to promotion, or current age while still open',
            },
          },
          byService: [...serviceResult].slice(0, serviceLimit).map((row) => ({
            service: row.service,
            currentIncidents: number(row.currentIncidents),
            previousIncidents: number(row.previousIncidents),
            currentAlerts: number(row.currentAlerts),
            previousAlerts: number(row.previousAlerts),
            currentAlertsPerIncident: currentSignalCoverageComplete
              ? ratio(number(row.currentAlerts), number(row.currentIncidents))
              : null,
            previousAlertsPerIncident: previousSignalCoverageComplete
              ? ratio(number(row.previousAlerts), number(row.previousIncidents))
              : null,
          })),
          byServiceNextCursor:
            serviceResult.length > serviceLimit
              ? (serviceResult[serviceLimit - 1]?.service ?? null)
              : null,
          topCauses: [...causeResult].slice(0, 20).map((row) => ({
            tag: row.tag,
            incidentCount: number(row.incidentCount),
          })),
          topCausesTruncated: causeResult.length > 20,
          topCauseCaveat:
            'Incident counts may reflect monitoring sensitivity and do not indicate severity or repair difficulty.',
        },
        toil: {
          created: {
            approvalDemands: number(toil.approvalDemands),
            clarificationRequests: number(toil.clarificationRequests),
            degradedReasks: number(toil.degradedReasks),
            findingCorrections: number(toil.findingCorrections),
          },
          removed: {
            averageFirstHypothesisSeconds: nullableNumber(toil.averageFirstHypothesisSeconds),
            humanTurnsPerProviderIncident: {
              numerator: humanTurns,
              denominator: providerIncidentCount,
              value: ratio(humanTurns, providerIncidentCount),
            },
            citedRunbookAdoption: {
              numerator: adoptedRuns,
              denominator: trustedRuns,
              rate: ratio(adoptedRuns, trustedRuns),
            },
            resolvedWithoutResponderOrApprovedAction: {
              numerator: unattendedResolved,
              denominator: providerIncidentCount,
              rate: ratio(unattendedResolved, providerIncidentCount),
            },
          },
          definitions: [
            'Responder turns and approval decisions are the disclosed human-tool-work proxy.',
            'First-hypothesis latency ends at the first durable investigation result with a ranked hypothesis.',
            'Runbook adoption means a cited search_runbooks evidence receipt in the trusted assessment.',
          ],
        },
      };
    }),
  );
}
