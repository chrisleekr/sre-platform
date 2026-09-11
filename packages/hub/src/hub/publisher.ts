import type { Redis } from 'ioredis';
import {
  shouldMirrorToSurfaces,
  SURFACE_STREAM,
  SURFACE_STREAM_MAXLEN,
  channel,
  type HubMessage,
} from './contracts';

export class HubPublisher {
  constructor(private readonly redis: Redis) {}

  /**
   * Post-commit fan-out half of {@link append}: pub/sub publish + surface-stream mirror. Call ONLY after
   * the tx that inserted the message committed — Redis is not transactional, so a publish/xadd for a
   * rolled-back row is exactly the orphaned-fan-out bug the split closes.
   */
  async publishAppended(message: HubMessage): Promise<void> {
    await this.redis.publish(channel(message.incidentId), JSON.stringify(message));
    await this.toSurfaceStream(message);
  }

  /** XADD a surface-worthy message onto the durable fan-out stream (Postgres was written first). */
  private async toSurfaceStream(message: HubMessage): Promise<void> {
    if (!shouldMirrorToSurfaces(message)) return;
    await this.redis.xadd(
      SURFACE_STREAM,
      'MAXLEN',
      '~',
      SURFACE_STREAM_MAXLEN,
      '*',
      'msg',
      JSON.stringify(message),
    );
  }

  /**
   * Fan out a message that was already persisted in an external transaction (pub/sub only, no write).
   * Used by the atomic degrade, where the brief + escalation rows are inserted together with
   * the incident status change so they can never be lost mid-post. Pub/sub loss is tolerable — the
   * Postgres log is the source of truth, and surfaces reconcile from `history`.
   */
  async publishPersisted(message: {
    id: string;
    incidentId: string;
    author: string;
    kind: string;
    content: string;
    summary?: string | null;
    finding?: HubMessage['finding'];
    createdAt: Date;
  }): Promise<void> {
    const payload: HubMessage = {
      id: message.id,
      incidentId: message.incidentId,
      author: message.author,
      kind: message.kind,
      content: message.content,
      summary: message.summary,
      finding: message.finding,
      createdAt: message.createdAt.toISOString(),
    };
    await this.redis.publish(channel(message.incidentId), JSON.stringify(payload));
    await this.toSurfaceStream(payload);
  }

  /**
   * Subscribe to live messages for an incident. Resolves once subscribed; returns an unsubscribe that
   * is idempotent and always releases the duplicated connection, so repeated or failing calls are safe.
   */
  async subscribe(
    incidentId: string,
    handler: (msg: HubMessage) => void,
  ): Promise<() => Promise<void>> {
    const sub = this.redis.duplicate();
    let released = false;
    await sub.subscribe(channel(incidentId));
    sub.on('message', (_channel, payload) => {
      handler(JSON.parse(payload) as HubMessage);
    });
    return async () => {
      // Callers release from several paths (session close, expiry timer, error unwind) and more than one
      // can run for the same session, so a second call must not command an already-disconnected socket.
      if (released) return;
      released = true;
      try {
        await sub.unsubscribe(channel(incidentId));
      } finally {
        // Release the duplicated connection even when the unsubscribe fails, or a Valkey fault leaks it
        // for the process lifetime.
        sub.disconnect();
      }
    };
  }
}
