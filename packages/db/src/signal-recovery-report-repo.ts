import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './client';
import { lockResponseGroupWorkTx } from './incident-relation-repo/causal';
import { withTenant, type Tx } from './rls';
import { incidentSignals, incidents, signalDispositions } from './schema';
import { clearRecoveryTx } from './signal-repo/recovery-state';

/** Correlation decision for an advisory Slack recovery notice that covers only its linked signal. */
export const PROVIDER_RECOVERY_REPORT_DECISION = 'recovery_reported';

/**
 * Correlation decision for an advisory Slack recovery notice that edited the alert message itself,
 * so it covers every active signal born from that message.
 */
export const PROVIDER_RECOVERY_REPORT_ROOT_DECISION = 'recovery_reported_root';

type RootedSignal = Pick<
  typeof incidentSignals.$inferSelect,
  | 'id'
  | 'incidentId'
  | 'state'
  | 'surface'
  | 'channel'
  | 'externalMessageId'
  | 'lastSeenAt'
  | 'monitorKey'
  | 'lastEventKey'
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

// The authenticated poster, which the monitor key does not hash: two bots in one channel can share a key.
function producerTag(signal: RootedSignal): string | null {
  const at = signal.lastEventKey.lastIndexOf(':producer:');
  return at < 0 ? null : signal.lastEventKey.slice(at);
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
  return withTenant(db, tenantId, (tx) => listProviderRecoveryReportsTx(tx, incidentId));
}

async function listProviderRecoveryReportsTx(
  tx: Tx,
  incidentId: string,
): Promise<Array<{ signalId: string; reportedAt: Date }>> {
  const later = alias(signalDispositions, 'later_event');
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
      monitorKey: incidentSignals.monitorKey,
      lastEventKey: incidentSignals.lastEventKey,
    })
    .from(incidentSignals)
    .where(or(eq(incidentSignals.incidentId, incidentId), inArray(incidentSignals.id, reportedIds)))
    .orderBy(asc(incidentSignals.firstSeenAt), asc(incidentSignals.id));
  const byId = new Map(signals.map((signal) => [signal.id, signal]));
  // A root-scoped report edited the alert message and records only the first signal it matched,
  // so it also covers the incident's other active signals born from that message. Either scope
  // covers earlier active signals of the reported monitor: a provider that posts a new message per
  // episode or re-posts while firing leaves one signal per post, and a later recovery ends them all.
  // One message naming several monitors covers one of them, so verification waits.
  return rows.flatMap((row) => {
    const reported = byId.get(row.signalId!);
    const root = reported ? messageRoot(reported) : null;
    const siblings = signals.filter(
      (signal) =>
        signal.id !== row.signalId &&
        signal.incidentId === incidentId &&
        signal.state !== 'resolved' &&
        // A sibling seen after the notice re-fired, so the notice no longer describes it.
        signal.lastSeenAt <= row.reportedAt &&
        ((row.decision === PROVIDER_RECOVERY_REPORT_ROOT_DECISION &&
          messageRoot(signal) === root) ||
          (Boolean(reported?.monitorKey) &&
            signal.monitorKey === reported!.monitorKey &&
            producerTag(signal) !== null &&
            producerTag(signal) === producerTag(reported!))),
    );
    return [row.signalId!, ...siblings.map((signal) => signal.id)].map((signalId) => ({
      signalId,
      reportedAt: row.reportedAt,
    }));
  });
}

/**
 * Resolves an open incident's active signals when current Slack recovery reports cover all of them.
 * @param tx - Tenant transaction; takes response-group work, incident, then signal locks.
 * @param tenantId - Owning tenant.
 * @param incidentId - Incident the reports were linked to.
 * @returns The resolved signal ids, how many signals were active before, and `closed` when the
 * incident is no longer open, so the caller does not read it as already cleared.
 */
export async function resolveReportedSignalsTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
): Promise<{ resolved: string[]; active: number; durable: boolean; closed?: true }> {
  // Recovery verification then checks the service. The clear is recorded as `unknown` provenance:
  // Slack text is not provider proof, so a `provider_clear` incident still refuses it and a
  // `verified_recovery` incident resolves only after verification. Partial coverage changes nothing.
  await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const [incident] = await tx
    .select({ status: incidents.status, archivedAt: incidents.archivedAt })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  if (!incident || incident.archivedAt || !['open', 'mitigated'].includes(incident.status))
    return { resolved: [], active: 0, durable: false, closed: true };
  const active = await tx
    .select({
      id: incidentSignals.id,
      lastSeenAt: incidentSignals.lastSeenAt,
      surface: incidentSignals.surface,
      state: incidentSignals.state,
      dataSourceId: incidentSignals.dataSourceId,
    })
    .from(incidentSignals)
    .where(and(eq(incidentSignals.incidentId, incidentId), ne(incidentSignals.state, 'resolved')))
    .orderBy(asc(incidentSignals.id))
    .for('update');
  // Only advisory Slack signals: a `firing` signal was established by a connector or the provider
  // and only provider or connector evidence may clear it.
  const durable = active.some(
    (signal) =>
      signal.surface !== 'slack' || signal.state !== 'unknown' || signal.dataSourceId !== null,
  );
  if (durable) return { resolved: [], active: active.length, durable };
  const reportedAt = new Map<string, Date>();
  for (const report of await listProviderRecoveryReportsTx(tx, incidentId)) {
    const seen = reportedAt.get(report.signalId);
    if (!seen || report.reportedAt > seen) reportedAt.set(report.signalId, report.reportedAt);
  }
  // A signal seen after its report fired again, so the report no longer describes it.
  if (
    active.length === 0 ||
    active.some((signal) => {
      const at = reportedAt.get(signal.id);
      return !at || at < signal.lastSeenAt;
    })
  )
    return { resolved: [], active: active.length, durable };
  for (const signal of active)
    await tx
      .update(incidentSignals)
      .set({
        state: 'resolved',
        clearProvenance: 'unknown',
        providerClearGeneration: null,
        lastEventType: 'resolved',
        resolvedAt: reportedAt.get(signal.id)!,
        version: sql`${incidentSignals.version} + 1`,
      })
      .where(eq(incidentSignals.id, signal.id));
  return { resolved: active.map((signal) => signal.id), active: active.length, durable };
}

/**
 * Reopens Slack signals that a recovery report resolved when their message fires again.
 * @param tx - Tenant transaction; takes response-group work, incident, then signal locks.
 * @param tenantId - Owning tenant.
 * @param incidentId - Incident that owns the signals.
 * @param signalIds - Signals born from the edited message.
 * @param refiredAt - Time of the firing edit.
 * @returns The reopened signal ids.
 */
export async function reopenReportedSignalsTx(
  tx: Tx,
  tenantId: string,
  incidentId: string,
  signalIds: string[],
  refiredAt: Date,
): Promise<string[]> {
  if (signalIds.length === 0) return [];
  // Only while the incident is open. The version bump breaks the signal fence, so a running
  // recovery verification stops instead of resolving the incident.
  const group = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const [incident] = await tx
    .select({ status: incidents.status, archivedAt: incidents.archivedAt })
    .from(incidents)
    .where(eq(incidents.id, incidentId))
    .limit(1)
    .for('update');
  if (!incident || incident.archivedAt || !['open', 'mitigated'].includes(incident.status))
    return [];
  const reopened = await tx
    .update(incidentSignals)
    .set({
      // Slack-born signals are advisory, so they reopen as `unknown`, never `firing`.
      state: 'unknown',
      clearProvenance: null,
      lastEventType: 'refired',
      resolvedAt: null,
      // Any report older than the re-fire no longer covers the signal.
      lastSeenAt: sql`greatest(${incidentSignals.lastSeenAt}, ${refiredAt.toISOString()}::timestamptz)`,
      version: sql`${incidentSignals.version} + 1`,
    })
    .where(
      and(
        eq(incidentSignals.incidentId, incidentId),
        inArray(incidentSignals.id, signalIds),
        eq(incidentSignals.surface, 'slack'),
        eq(incidentSignals.state, 'resolved'),
        eq(incidentSignals.clearProvenance, 'unknown'),
        // A firing edit delivered after a newer recovery report describes an earlier state.
        lt(incidentSignals.resolvedAt, refiredAt),
      ),
    )
    .returning({ id: incidentSignals.id });
  // As a repeat firing does: retire the queued verification and the stale recovery projection.
  if (reopened.length > 0)
    await clearRecoveryTx(tx, tenantId, group.rootIncidentId, group.incidentIds);
  return reopened.map((signal) => signal.id);
}
