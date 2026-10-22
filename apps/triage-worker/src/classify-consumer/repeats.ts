import type { InboundCandidate } from '@sre/connectors';
import { ACTIVE_WINDOW_MS } from './contracts';
import type { ClassifyCore } from './core';
import { matchOpenProducerSignals } from './recovery-report';

/** Recognizes a repeat notification of a monitor that an open incident already tracks. */
export class RepeatNotifications {
  constructor(private readonly core: ClassifyCore) {}

  /**
   * Returns the tracking incident when every alert in a bot firing message carries a monitor
   * identity already tracked by an open signal of one incident. When several open incidents track
   * the monitor, the one holding the most recently seen signal wins.
   * @param tenantId - Owning tenant.
   * @param candidate - Inbound candidate.
   */
  async match(
    tenantId: string,
    candidate: InboundCandidate,
  ): Promise<{ incidentId: string; signalId: string } | null> {
    // alertKind is not required: the adapter sets it only for recognised firing shapes, and a
    // monitor identity on every observation is already the stronger provider-shape proof.
    if (
      candidate.author !== 'bot' ||
      candidate.isEdit ||
      candidate.signalState !== 'firing' ||
      candidate.observations?.some((observation) => observation.state !== 'firing')
    )
      return null;
    // A resolved signal still counts while its incident is open: a re-fire during recovery
    // verification belongs to that incident, and its new signal stops the verification.
    const matched = await matchOpenProducerSignals(this.core, tenantId, candidate, {
      includeResolved: true,
    });
    if (matched.length === 0) return null;
    // Refusing on two tracking incidents made every later firing open a third, so the newest wins.
    // Resolving never moves lastSeenAt, so the incident under verification stays the newest and a
    // re-fire stops its check.
    const latest = matched.reduce((newest, signal) =>
      signal.lastSeenAt > newest.lastSeenAt ? signal : newest,
    );
    // A signal that never recovered is the same episode however long ago it fired. One that
    // recovered longer ago than the window is a new episode needing its own classification; the
    // window runs from the recovery, since resolving leaves lastSeenAt at the last firing.
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    const current = (signal: (typeof matched)[number]) =>
      signal.state !== 'resolved' || (signal.resolvedAt ?? signal.lastSeenAt).getTime() >= cutoff;
    // A grouped message can mix a tracked alert with a new one; the new alert needs classification.
    const tracked = new Set(
      matched
        .filter((signal) => signal.incidentId === latest.incidentId && current(signal))
        .map((signal) => signal.monitorKey),
    );
    if (candidate.observations?.some((observation) => !tracked.has(observation.monitorKey ?? null)))
      return null;
    return { incidentId: latest.incidentId, signalId: latest.id };
  }
}
