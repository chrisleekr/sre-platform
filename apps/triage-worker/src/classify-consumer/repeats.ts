import type { InboundCandidate } from '@sre/connectors';
import { ACTIVE_WINDOW_MS } from './contracts';
import type { ClassifyCore } from './core';
import { matchOpenProducerSignals } from './recovery-report';

/** Recognizes a repeat notification of a monitor that an open incident already tracks. */
export class RepeatNotifications {
  constructor(private readonly core: ClassifyCore) {}

  /**
   * Returns the tracking incident when every alert in a bot firing message carries a monitor
   * identity already tracked by an open signal, and those signals belong to one incident seen
   * within the active window.
   * @param tenantId - Owning tenant.
   * @param candidate - Scrubbed inbound candidate.
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
    const signals = await matchOpenProducerSignals(this.core, tenantId, candidate);
    // A grouped message can mix a tracked alert with a new one; the new alert needs classification.
    const tracked = new Set(signals.map((signal) => signal.monitorKey));
    if (candidate.observations?.some((observation) => !tracked.has(observation.monitorKey ?? null)))
      return null;
    if (new Set(signals.map((signal) => signal.incidentId)).size !== 1) return null;
    const latest = signals.reduce((newest, signal) =>
      signal.lastSeenAt > newest.lastSeenAt ? signal : newest,
    );
    // An old episode on a long-open incident is not evidence that this firing is the same one.
    if (latest.lastSeenAt.getTime() < Date.now() - ACTIVE_WINDOW_MS) return null;
    return { incidentId: latest.incidentId, signalId: latest.id };
  }
}
