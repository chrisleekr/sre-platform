import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Redis } from 'ioredis';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from '../auth';

export interface TicketContext {
  applicationSessionId?: string;
  tenantId: string;
  sub: string;
  /** Canonical platform user used for attribution and the post-redeem durable revocation check. */
  userId: string;
  /** Sign-in method whose eligibility remains authoritative for this session. */
  providerId: string;
  /** Issue time of the verified bearer token, in Unix milliseconds. */
  tokenIssuedAt: number;
  /**
   * Deadline of the access token this ticket was minted from, in Unix MILLISECONDS. Required and
   * never null: the session opened from this ticket closes at this moment, so a ticket that cannot state
   * a deadline is a session that would never end and must fail to redeem instead.
   */
  tokenExpiresAt: number;
}

const PREFIX = 'ws:ticket:';
const VERSION = 2;
const TAG_BYTES = 32;
const HKDF_INFO = Buffer.from('sre-platform/ws-ticket/v2', 'utf8');

interface TicketEnvelope {
  version: number;
  payload: string;
  expiresAt: number;
  tag: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Short-lived single-use WebSocket tickets. Browsers cannot set headers on a WS
 * handshake, and putting a bearer token in the URL leaks it into access logs. Instead
 * the authenticated SPA mints a ticket over HTTP, then connects with `?ticket=`. The
 * ticket is opaque, expires in seconds, and is redeemed exactly once.
 */
export class TicketStore {
  private readonly authKey: Buffer;

  constructor(
    private readonly redis: Redis,
    private readonly ttlSec = 30,
    masterKey: string,
  ) {
    const decoded = Buffer.from(masterKey, 'base64');
    if (decoded.length !== 32) {
      throw new Error('SECRETS_MASTER_KEY must decode to 32 bytes');
    }
    this.authKey = Buffer.from(hkdfSync('sha256', decoded, Buffer.alloc(0), HKDF_INFO, TAG_BYTES));
  }

  private tag(ticket: string, payload: string, expiresAt: number): Buffer {
    return createHmac('sha256', this.authKey)
      .update(JSON.stringify([VERSION, ticket, payload, expiresAt]))
      .digest();
  }

  async mint(ctx: TicketContext): Promise<{ ticket: string; expiresIn: number }> {
    const ticket = randomBytes(32).toString('base64url');
    const payload = JSON.stringify(ctx);
    const expiresAt = Math.trunc(Date.now() + this.ttlSec * 1_000);
    const envelope: TicketEnvelope = {
      version: VERSION,
      payload,
      expiresAt,
      tag: this.tag(ticket, payload, expiresAt).toString('base64url'),
    };
    await this.redis.set(PREFIX + ticket, JSON.stringify(envelope), 'EX', this.ttlSec);
    return { ticket, expiresIn: this.ttlSec };
  }

  /** Atomically fetch-and-delete (single use). Returns null if missing, expired, or already used. */
  async redeem(ticket: string): Promise<TicketContext | null> {
    if (!ticket) return null;
    const raw = await this.redis.getdel(PREFIX + ticket);
    if (!raw) return null;
    try {
      const envelope: unknown = JSON.parse(raw);
      if (!isRecord(envelope)) return null;
      const { version, payload, expiresAt, tag } = envelope;
      if (
        version !== VERSION ||
        typeof payload !== 'string' ||
        typeof expiresAt !== 'number' ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        typeof tag !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(tag)
      ) {
        return null;
      }

      const actualTag = Buffer.from(tag, 'base64url');
      const expectedTag = this.tag(ticket, payload, expiresAt);
      if (actualTag.length !== expectedTag.length || !timingSafeEqual(actualTag, expectedTag)) {
        return null;
      }

      const context: unknown = JSON.parse(payload);
      if (!isRecord(context)) return null;
      const {
        tenantId,
        sub,
        userId,
        providerId,
        tokenIssuedAt,
        tokenExpiresAt,
        applicationSessionId,
      } = context;
      if (
        (applicationSessionId !== undefined &&
          (typeof applicationSessionId !== 'string' ||
            !/^[a-f0-9-]{36}$/i.test(applicationSessionId))) ||
        typeof tenantId !== 'string' ||
        tenantId.length === 0 ||
        typeof sub !== 'string' ||
        sub.length === 0 ||
        typeof userId !== 'string' ||
        userId.length === 0 ||
        typeof providerId !== 'string' ||
        providerId.length === 0 ||
        typeof tokenIssuedAt !== 'number' ||
        !Number.isFinite(tokenIssuedAt) ||
        tokenIssuedAt <= 0 ||
        // A missing, non-finite or non-positive deadline redeems to nothing rather than to a
        // deadline-free session; NaN and Infinity both fail this, so no arithmetic downstream can
        // produce a timer that never fires.
        typeof tokenExpiresAt !== 'number' ||
        !Number.isFinite(tokenExpiresAt) ||
        tokenExpiresAt <= tokenIssuedAt
      ) {
        return null;
      }
      return {
        tenantId,
        sub,
        userId,
        providerId,
        tokenIssuedAt,
        tokenExpiresAt,
        ...(applicationSessionId ? { applicationSessionId: applicationSessionId as string } : {}),
      };
    } catch {
      return null;
    }
  }
}

export interface TicketRouteDeps {
  auth: AuthDeps;
  tickets: TicketStore;
}

/** `POST /ws/ticket` — authenticated (Bearer JWT); returns a ticket for the WS handshake. */
export function ticketRoutes(deps: TicketRouteDeps): Hono<{ Variables: TenantAuthVariables }> {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.post('/ticket', authMiddleware(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    return c.json(
      await deps.tickets.mint({
        tenantId: tenant.tenantId,
        sub: tenant.sub,
        userId: tenant.userId,
        providerId: c.get('user').providerId,
        applicationSessionId: c.get('user').applicationSessionId,
        tokenIssuedAt: tenant.issuedAt * 1_000,
        // The ONE seconds-to-milliseconds conversion in this path: the token's `exp` is Unix seconds
        // (RFC 7519), every ticket and session deadline downstream is milliseconds. Do not add another.
        tokenExpiresAt: tenant.expiresAt * 1_000,
      }),
    );
  });
  return app;
}
