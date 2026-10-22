import type { InboundCandidate } from '@sre/connectors';
import {
  getIncident,
  getSignalByExternal,
  listActiveSlackSignalsByMonitorKeys,
  listSignalsByExternalRoot,
  reopenReportedSignalsTx,
  withTenant,
} from '@sre/db';
import { RECOVERY_NOT_QUEUED, startReportedRecoveryTx } from '../recovery-start';
import type { ClassifyCore } from './core';

type MatchedSignal = NonNullable<Awaited<ReturnType<typeof getSignalByExternal>>>;

/**
 * Finds Slack-born signals from the same channel and authenticated producer as a bot event.
 * An edit keeps its root `ts`, so it matches by exact root; a new message matches by monitor identity.
 * Returns only signals whose incident is open or mitigated, and only unresolved ones unless
 * `includeResolved` is set: an incident stays open while a reported recovery is verified.
 * @param core - Classify collaborators.
 * @param tenantId - Owning tenant.
 * @param candidate - Inbound candidate.
 * @param options - `includeResolved` also matches resolved signals of an open incident;
 * `resolvedOnly` matches only those.
 */
export async function matchOpenProducerSignals(
  core: ClassifyCore,
  tenantId: string,
  candidate: InboundCandidate,
  options: { includeResolved?: boolean; resolvedOnly?: boolean } = {},
): Promise<MatchedSignal[]> {
  if (candidate.author !== 'bot' || !candidate.producerId) return [];
  const db = core.deps.appDb;
  let signals: MatchedSignal[];
  if (candidate.isEdit) {
    const [plain, grouped] = await Promise.all([
      getSignalByExternal(db, tenantId, 'slack', candidate.channel, candidate.externalId),
      listSignalsByExternalRoot(db, tenantId, 'slack', candidate.channel, candidate.externalId),
    ]);
    signals = [...(plain ? [plain] : []), ...grouped];
  } else {
    const observations = candidate.observations ?? [];
    // A message without a monitor identity for every alert cannot be attributed deterministically.
    if (observations.length === 0 || observations.some((observation) => !observation.monitorKey))
      return [];
    signals = await listActiveSlackSignalsByMonitorKeys(
      db,
      tenantId,
      candidate.channel,
      candidate.producerId,
      observations.map((observation) => observation.monitorKey!),
      { includeResolved: options.includeResolved || options.resolvedOnly },
    );
  }
  const producerTag = `:producer:${candidate.producerId}`;
  const scoped = signals.filter(
    (signal) =>
      (options.resolvedOnly
        ? signal.state === 'resolved'
        : options.includeResolved || signal.state !== 'resolved') &&
      signal.channel === candidate.channel &&
      signal.lastEventKey.endsWith(producerTag),
  );
  const open = new Set<string>();
  for (const incidentId of new Set(scoped.map((signal) => signal.incidentId))) {
    const incident = await getIncident(db, tenantId, incidentId);
    if (incident && !incident.archivedAt && ['open', 'mitigated'].includes(incident.status))
      open.add(incidentId);
  }
  return scoped.filter((signal) => open.has(signal.incidentId));
}

// The adapter marks a message resolved when any line carries a resolved header, which a grouped
// message listing both firing and resolved alerts also does. Only a message that opens with one
// reports the whole message recovered.
function opensWithResolvedHeader(text: string): boolean {
  const first = text.split('\n').find((line) => line.trim() !== '') ?? '';
  return /^\s*(?:<[^|>\n]+\|)?\[\s*resolved\b/i.test(first);
}

// Anywhere in the text, behind an emoji, bold or a title line: an alert the message still shows firing.
const FIRING_HEADER = /\[\s*firing(?:\s*:\s*\d+)?\s*\]/i;

/** Links a Slack recovery notice to the one incident it describes and starts verification. */
export class RecoveryReports {
  constructor(private readonly core: ClassifyCore) {}

  /**
   * Finds the open incident a recovery notice describes; when several track the monitor, the one
   * holding the most recently seen signal. Scope is `root` only for an edit whose message opens
   * with a resolved header, so the whole message recovered; otherwise `signal`, covering just the
   * matched signal. A message that still shows a firing alert cannot say which of its alerts
   * recovered, so it stays advisory, as does any edit without a resolved header. Resolved signals
   * of an open incident still match, so a redelivered notice whose first delivery already resolved
   * them links to the same incident.
   * @param tenantId - Owning tenant.
   * @param candidate - Resolved candidate.
   */
  async link(
    tenantId: string,
    candidate: InboundCandidate,
  ): Promise<{ incidentId: string; signalId: string; scope: 'root' | 'signal' } | null> {
    const root = opensWithResolvedHeader(candidate.text);
    if (FIRING_HEADER.test(candidate.text) || (candidate.isEdit && !root)) return null;
    const matched = await matchOpenProducerSignals(this.core, tenantId, candidate, {
      includeResolved: true,
    });
    if (matched.length === 0) return null;
    // Same choice as repeat matching. Resolving never moves lastSeenAt, so a redelivery after the
    // first delivery resolved the signal still picks the same incident.
    const signal = matched.reduce((newest, next) =>
      next.lastSeenAt > newest.lastSeenAt ? next : newest,
    );
    return {
      incidentId: signal.incidentId,
      signalId: signal.id,
      scope: candidate.isEdit && root ? 'root' : 'signal',
    };
  }

  /**
   * Acts on a recorded notice. When current reports cover every active signal, resolves them and
   * queues recovery verification, which checks the service before the incident resolves; Slack
   * text alone never resolves it. Otherwise posts the notice as advisory. One transaction, keyed by
   * the event, so a redelivered notice writes and queues nothing new; the line is still published,
   * because the first delivery may have committed and died before publishing.
   * @param tenantId - Owning tenant.
   * @param incidentId - Incident the notice was linked to.
   * @param candidate - Resolved candidate.
   */
  async settle(tenantId: string, incidentId: string, candidate: InboundCandidate): Promise<void> {
    const { hub, queue } = this.core.deps;
    if (!hub?.appendTxOnce) throw new Error('classify recovery report path is not wired (hub)');
    const reportedAt = new Date(candidate.eventAt).toISOString();
    const settled = await withTenant(this.core.deps.appDb, tenantId, async (tx) => {
      const { resolved, active, durable, prepared, queued, jobId } = await startReportedRecoveryTx(
        tx,
        queue,
        tenantId,
        incidentId,
      );
      const reported = `Provider reported recovery in Slack at ${reportedAt}.`;
      const { message } = await hub.appendTxOnce!(tx, tenantId, incidentId, {
        author: 'system',
        kind: 'status',
        content: queued
          ? `${reported} Verifying recovery before resolving.`
          : prepared
            ? `${reported} ${RECOVERY_NOT_QUEUED}`
            : resolved.length > 0
              ? `${reported} Verification waits for the other incidents in this response group.`
              : durable
                ? `${reported} Provider-verified alerts stay active until the provider clears them.`
                : active > 0
                  ? `${reported} Verification starts when every active alert on this incident has reported recovery.`
                  : reported,
        originMessageId: `slack-recovery:${candidate.eventKey}`,
      });
      return { message, jobId };
    });
    await this.core.publishAppended(settled.message);
    if (settled.jobId) await this.core.publishJob(settled.jobId);
  }

  /**
   * Reopens signals a recovery report resolved when their message is edited back to firing, which
   * stops any recovery verification for the incident.
   * @param tenantId - Owning tenant.
   * @param candidate - Firing edit.
   */
  async reopen(tenantId: string, candidate: InboundCandidate): Promise<boolean> {
    const { hub } = this.core.deps;
    const signals = await matchOpenProducerSignals(this.core, tenantId, candidate, {
      resolvedOnly: true,
    });
    if (new Set(signals.map((signal) => signal.incidentId)).size !== 1) return false;
    if (!hub?.appendTxOnce) throw new Error('classify recovery report path is not wired (hub)');
    const incidentId = signals[0]!.incidentId;
    const message = await withTenant(this.core.deps.appDb, tenantId, async (tx) => {
      const reopened = await reopenReportedSignalsTx(
        tx,
        tenantId,
        incidentId,
        signals.map((signal) => signal.id),
        new Date(candidate.eventAt),
      );
      if (reopened.length === 0) return null;
      const appended = await hub.appendTxOnce!(tx, tenantId, incidentId, {
        author: 'system',
        kind: 'status',
        content: `Alert fired again in Slack at ${new Date(candidate.eventAt).toISOString()}. Recovery is no longer reported.`,
        originMessageId: `slack-refired:${candidate.eventKey}`,
      });
      return appended.inserted ? appended.message : null;
    });
    if (message) await this.core.publishAppended(message);
    return message !== null;
  }
}
