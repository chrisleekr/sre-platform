import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, notExists, or, sql } from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import { withTenant } from './rls';
import { incidentSignals, signalDispositions } from './schema';

/** Correlation decision for an advisory Slack recovery notice that covers only its linked signal. */
export const PROVIDER_RECOVERY_REPORT_DECISION = 'recovery_reported';

/**
 * Correlation decision for an advisory Slack recovery notice that edited the alert message itself,
 * so it covers every active signal born from that message.
 */
export const PROVIDER_RECOVERY_REPORT_ROOT_DECISION = 'recovery_reported_root';

type RootedSignal = Pick<
  typeof incidentSignals.$inferSelect,
  'id' | 'incidentId' | 'state' | 'surface' | 'channel' | 'externalMessageId' | 'lastSeenAt'
>;

// Mirrors sourceEventOrder in signal-control-repo: a numeric version orders events, otherwise receipt
// time in microseconds plus 999.
function eventOrder(table: { sourceEventVersion: AnyPgColumn; sourceEventAt: AnyPgColumn }) {
  return sql`case when ${table.sourceEventVersion} ~ '^-?[0-9]+$' then ${table.sourceEventVersion}::numeric else extract(epoch from ${table.sourceEventAt}) * 1000000 + 999 end`;
}

// Grouped Slack alerts are stored as `<message>#<alert>`, so the part before `#` names the message.
function messageRoot(signal: RootedSignal): string {
  return JSON.stringify([signal.surface, signal.channel, signal.externalMessageId.split('#')[0]]);
}

/**
 * Current advisory Slack recovery reports for one incident, oldest first, one row per covered signal.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param incidentId - Incident the reports were linked to.
 */
export function listProviderRecoveryReports(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<Array<{ signalId: string; reportedAt: Date }>> {
  const later = alias(signalDispositions, 'later_event');
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        signalId: signalDispositions.correlatedSignalId,
        reportedAt: signalDispositions.sourceEventAt,
        decision: signalDispositions.correlationDecision,
      })
      .from(signalDispositions)
      .where(
        and(
          eq(signalDispositions.correlatedIncidentId, incidentId),
          inArray(signalDispositions.correlationDecision, [
            PROVIDER_RECOVERY_REPORT_DECISION,
            PROVIDER_RECOVERY_REPORT_ROOT_DECISION,
          ]),
          // A newer event for the same monitor supersedes a report, so a re-fired alert no longer
          // reads as recovered.
          isNull(signalDispositions.supersededAt),
          isNotNull(signalDispositions.correlatedSignalId),
          // Supersession keys on the first alert's monitor, so an edit back to firing whose first
          // alert differs leaves a root report current. Any later event on the same message retires it.
          or(
            ne(signalDispositions.correlationDecision, PROVIDER_RECOVERY_REPORT_ROOT_DECISION),
            notExists(
              tx
                .select({ id: later.id })
                .from(later)
                .where(
                  and(
                    eq(later.tenantId, signalDispositions.tenantId),
                    eq(later.source, signalDispositions.source),
                    eq(later.surface, signalDispositions.surface),
                    eq(later.channel, signalDispositions.channel),
                    eq(later.threadId, signalDispositions.threadId),
                    gt(eventOrder(later), eventOrder(signalDispositions)),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(asc(signalDispositions.sourceEventAt), asc(signalDispositions.id));
    if (rows.length === 0) return [];
    const reportedIds = [...new Set(rows.map((row) => row.signalId!))];
    const signals: RootedSignal[] = await tx
      .select({
        id: incidentSignals.id,
        incidentId: incidentSignals.incidentId,
        state: incidentSignals.state,
        surface: incidentSignals.surface,
        channel: incidentSignals.channel,
        externalMessageId: incidentSignals.externalMessageId,
        lastSeenAt: incidentSignals.lastSeenAt,
      })
      .from(incidentSignals)
      .where(
        or(eq(incidentSignals.incidentId, incidentId), inArray(incidentSignals.id, reportedIds)),
      )
      .orderBy(asc(incidentSignals.firstSeenAt), asc(incidentSignals.id));
    const byId = new Map(signals.map((signal) => [signal.id, signal]));
    // A root-scoped report edited the alert message and records only the first signal it matched,
    // so it also covers the incident's other active signals born from that message. A new recovery
    // message matched by monitor identity covers exactly its linked signal: one message naming
    // several alerts therefore covers one of them, and confirmation stays hidden (fails closed).
    return rows.flatMap((row) => {
      if (row.decision !== PROVIDER_RECOVERY_REPORT_ROOT_DECISION)
        return [{ signalId: row.signalId!, reportedAt: row.reportedAt }];
      const reported = byId.get(row.signalId!);
      const root = reported ? messageRoot(reported) : null;
      const siblings = signals.filter(
        (signal) =>
          signal.id !== row.signalId &&
          signal.incidentId === incidentId &&
          signal.state !== 'resolved' &&
          // A sibling seen after the notice re-fired, so the notice no longer describes it.
          signal.lastSeenAt <= row.reportedAt &&
          messageRoot(signal) === root,
      );
      return [row.signalId!, ...siblings.map((signal) => signal.id)].map((signalId) => ({
        signalId,
        reportedAt: row.reportedAt,
      }));
    });
  });
}
