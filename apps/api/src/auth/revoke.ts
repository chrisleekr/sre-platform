import { WS_CLOSE_POLICY } from '@sre/contracts';
import type { Redis } from 'ioredis';

export const REVOKE_CHANNEL = 'sre:auth:revoke';

export interface RevokeMessage {
  userId: string;
  tenantId?: string;
  applicationSessionId?: string;
}

export interface RevokePublisher {
  publish(message: RevokeMessage): Promise<void>;
}

function parseMessage(raw: string): RevokeMessage | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const { userId, tenantId, applicationSessionId } = value as Record<string, unknown>;
    if (typeof userId !== 'string' || userId.length === 0) return null;
    if (tenantId !== undefined && (typeof tenantId !== 'string' || tenantId.length === 0)) {
      return null;
    }
    if (
      applicationSessionId !== undefined &&
      (typeof applicationSessionId !== 'string' || !applicationSessionId)
    )
      return null;
    return {
      userId,
      ...(tenantId === undefined ? {} : { tenantId }),
      ...(applicationSessionId === undefined ? {} : { applicationSessionId }),
    };
  } catch {
    return null;
  }
}

/** Creates a best-effort publisher for durable credential revocations. */
export function makeRevokePublisher(redis: Redis): RevokePublisher {
  return {
    async publish(message) {
      try {
        await redis.publish(REVOKE_CHANNEL, JSON.stringify(message));
      } catch {
        // Durable account and browser-session gates remain authoritative when a hint is missed.
      }
    },
  };
}

interface RegisteredSession {
  id: symbol;
  tenantId: string;
  applicationSessionId?: string;
  close: (code: number, reason: string) => void;
}

/** Tracks one replica's open user sessions and applies cross-replica revocations. */
export class SessionRegistry {
  private readonly sessions = new Map<string, Map<symbol, RegisteredSession>>();
  private subscriber: Redis | null = null;

  private readonly onMessage = (channel: string, raw: string): void => {
    if (channel !== REVOKE_CHANNEL) return;
    const message = parseMessage(raw);
    if (!message) return;
    const matches = this.sessions.get(message.userId);
    if (!matches) return;
    for (const session of matches.values()) {
      if (message.tenantId && session.tenantId !== message.tenantId) continue;
      if (
        message.applicationSessionId &&
        session.applicationSessionId !== message.applicationSessionId
      )
        continue;
      matches.delete(session.id);
      session.close(WS_CLOSE_POLICY, 'signed out');
    }
    if (matches.size === 0) this.sessions.delete(message.userId);
  };

  /**
   * Registers one open session and returns an idempotent deregistration callback.
   *
   * @param userId - Canonical platform user owning the session.
   * @param tenantId - Tenant selected for the session.
   * @param close - Transport closure callback.
   * @param applicationSessionId - Exact browser session; absent for bearer credentials.
   */
  register(
    userId: string,
    tenantId: string,
    close: (code: number, reason: string) => void,
    applicationSessionId?: string,
  ): () => void {
    const id = Symbol('session');
    const sessions = this.sessions.get(userId) ?? new Map<symbol, RegisteredSession>();
    sessions.set(id, { id, tenantId, close, applicationSessionId });
    this.sessions.set(userId, sessions);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = this.sessions.get(userId);
      current?.delete(id);
      if (current?.size === 0) this.sessions.delete(userId);
    };
  }

  /**
   * Subscribes this replica to revocation events.
   *
   * @param subscriber - Dedicated Valkey connection owned by this registry.
   */
  async start(subscriber: Redis): Promise<void> {
    if (this.subscriber) return;
    this.subscriber = subscriber;
    subscriber.on('message', this.onMessage);
    try {
      await subscriber.subscribe(REVOKE_CHANNEL);
    } catch (error) {
      subscriber.removeListener('message', this.onMessage);
      this.subscriber = null;
      throw error;
    }
  }

  /** Stops the subscriber owned by this registry. */
  async close(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = null;
    if (!subscriber) return;
    subscriber.removeListener('message', this.onMessage);
    await subscriber.unsubscribe(REVOKE_CHANNEL).catch(() => undefined);
    subscriber.disconnect();
  }
}
