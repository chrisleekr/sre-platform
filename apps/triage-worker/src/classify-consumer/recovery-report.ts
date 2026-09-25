import type { InboundCandidate } from '@sre/connectors';
import {
  getIncident,
  getSignalByExternal,
  listActiveSlackSignalsByMonitorKeys,
  listSignalsByExternalRoot,
} from '@sre/db';
import type { ClassifyCore } from './core';

type MatchedSignal = NonNullable<Awaited<ReturnType<typeof getSignalByExternal>>>;

/**
 * Finds open Slack-born signals from the same channel and authenticated producer as a bot event.
 * An edit keeps its root `ts`, so it matches by exact root; a new message matches by monitor identity.
 * Returns only signals whose incident is open or mitigated.
 * @param core - Classify collaborators.
 * @param tenantId - Owning tenant.
 * @param candidate - Scrubbed inbound candidate.
 */
export async function matchOpenProducerSignals(
  core: ClassifyCore,
  tenantId: string,
  candidate: InboundCandidate,
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
    );
  }
  const producerTag = `:producer:${candidate.producerId}`;
  const scoped = signals.filter(
    (signal) =>
      signal.state !== 'resolved' &&
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

/** Links an advisory Slack recovery notice to the one incident it describes. */
export class RecoveryReports {
  constructor(private readonly core: ClassifyCore) {}

  /**
   * Appends one advisory hub line when the notice matches signals of exactly one open incident.
   * Slack text never changes lifecycle; an operator confirms resolution from the dashboard.
   * Scope is `root` only for an edit whose message opens with a resolved header, so the whole
   * message recovered; otherwise `signal`, covering just the matched signal.
   * @param tenantId - Owning tenant.
   * @param candidate - Scrubbed resolved candidate.
   */
  async link(
    tenantId: string,
    candidate: InboundCandidate,
  ): Promise<{ incidentId: string; signalId: string; scope: 'root' | 'signal' } | null> {
    const signals = await matchOpenProducerSignals(this.core, tenantId, candidate);
    const incidents = new Set(signals.map((signal) => signal.incidentId));
    if (incidents.size !== 1) return null;
    const { hub } = this.core.deps;
    if (!hub) throw new Error('classify recovery report path is not wired (hub)');
    const signal = signals[0]!;
    // Keyed by the event, so a redelivered notice or a replayed job appends nothing new.
    await hub.appendOnce(tenantId, signal.incidentId, {
      author: 'system',
      kind: 'status',
      content: `Provider reported recovery in Slack at ${new Date(candidate.eventAt).toISOString()}. Slack text is advisory; confirm to resolve.`,
      originMessageId: `slack-recovery:${candidate.eventKey}`,
    });
    return {
      incidentId: signal.incidentId,
      signalId: signal.id,
      scope: candidate.isEdit && opensWithResolvedHeader(candidate.text) ? 'root' : 'signal',
    };
  }
}
