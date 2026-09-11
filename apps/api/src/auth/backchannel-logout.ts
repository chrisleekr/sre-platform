import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { applyBackchannelLogout, type BackchannelLogoutTarget, type Db } from '@sre/db';
import type { PublicRateLimiter } from '../onboarding/contracts';
import type { RevokePublisher } from './revoke';

const EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const MAX_BODY_BYTES = 32 * 1024;
const MAX_LOGOUT_TOKEN_CHARS = MAX_BODY_BYTES - 256;
const MAX_IDENTIFIER_CHARS = 2_048;
const MAX_TOKEN_AGE_SECONDS = 5 * 60;
const INGRESS_LIMIT = 600;
const INGRESS_WINDOW_MS = 60_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface BackchannelLogoutProvider {
  id: string;
  issuer: string;
  browserClientId: string;
  typRequired: boolean;
  keys: JWTVerifyGetKey;
  enabled: boolean;
}

export interface BackchannelLogoutDeps {
  db: Db;
  resolveProvider(providerId: string): Promise<BackchannelLogoutProvider | undefined>;
  limiter?: PublicRateLimiter;
  sourceAddress?: (context: Context) => string;
  revoke: RevokePublisher;
}

type Variables = { backchannelLogoutProvider: BackchannelLogoutProvider };

function invalid(c: Context) {
  c.header('Cache-Control', 'no-store');
  return c.json({ error: 'invalid_request' }, 400);
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength ? value : null;
}

function hasLogoutEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = (value as Record<string, unknown>)[EVENT];
  return Boolean(event && typeof event === 'object' && !Array.isArray(event));
}

/** Builds the provider-authenticated OpenID Connect back-channel logout endpoint. */
export function backchannelLogoutRoutes(
  deps: BackchannelLogoutDeps,
): Hono<{ Variables: Variables }> {
  const routes = new Hono<{ Variables: Variables }>();
  const path = '/auth/providers/:providerId/backchannel-logout';
  routes.use(path, async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!deps.limiter || !deps.sourceAddress) {
      return c.json({ error: 'back-channel logout is unavailable' }, 503);
    }
    try {
      const source = deps.sourceAddress(c);
      const allowed = await deps.limiter.allow(
        'oidc-backchannel',
        source,
        INGRESS_LIMIT,
        INGRESS_WINDOW_MS,
      );
      if (!allowed) {
        c.header('Retry-After', '60');
        return c.json({ error: 'too many back-channel logout requests' }, 429);
      }
    } catch {
      return c.json({ error: 'back-channel logout is unavailable' }, 503);
    }
    await next();
  });
  routes.use(path, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: invalid }));
  routes.post(
    path,
    async (c, next) => {
      const providerId = c.req.param('providerId');
      if (!ID.test(providerId)) return c.json({ error: 'unsupported' }, 404);
      const provider = await deps.resolveProvider(providerId);
      if (!provider?.enabled) return c.json({ error: 'unsupported' }, 404);
      c.set('backchannelLogoutProvider', provider);
      await next();
    },
    async (c) => {
      const provider = c.get('backchannelLogoutProvider');
      const mediaType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      if (mediaType !== 'application/x-www-form-urlencoded') return invalid(c);
      const encoded = await c.req.text().catch(() => null);
      const token =
        encoded &&
        boundedString(new URLSearchParams(encoded).get('logout_token'), MAX_LOGOUT_TOKEN_CHARS);
      if (!token) return invalid(c);
      let payload;
      let protectedHeader;
      try {
        ({ payload, protectedHeader } = await jwtVerify(token, provider.keys, {
          issuer: provider.issuer,
          audience: provider.browserClientId,
          algorithms: ['RS256'],
          maxTokenAge: MAX_TOKEN_AGE_SECONDS,
          requiredClaims: ['iat', 'exp', 'jti', 'events'],
        }));
      } catch {
        return invalid(c);
      }
      const subject = boundedString(payload.sub, MAX_IDENTIFIER_CHARS);
      const sessionId = boundedString(payload.sid, MAX_IDENTIFIER_CHARS);
      const jti = boundedString(payload.jti, MAX_IDENTIFIER_CHARS);
      if (
        !jti ||
        typeof payload.iat !== 'number' ||
        !Number.isFinite(payload.iat) ||
        typeof payload.exp !== 'number' ||
        !Number.isFinite(payload.exp) ||
        payload.iat >= payload.exp ||
        !hasLogoutEvent(payload.events) ||
        payload.nonce !== undefined ||
        (provider.typRequired && protectedHeader.typ !== 'logout+jwt') ||
        (payload.azp !== undefined && payload.azp !== provider.browserClientId) ||
        (Array.isArray(payload.aud) && payload.aud.length !== 1) ||
        (!subject && !sessionId)
      ) {
        return invalid(c);
      }
      const target: BackchannelLogoutTarget = sessionId
        ? {
            kind: 'session',
            oidcSessionId: sessionId,
            ...(subject ? { oidcSubject: subject } : {}),
          }
        : { kind: 'subject', oidcSubject: subject! };
      let result;
      try {
        result = await applyBackchannelLogout(deps.db, {
          providerId: provider.id,
          clientId: provider.browserClientId,
          jtiHash: createHash('sha256').update(jti).digest('hex'),
          expiresAt: new Date(Math.min(payload.exp, payload.iat + MAX_TOKEN_AGE_SECONDS) * 1_000),
          target,
        });
      } catch {
        return invalid(c);
      }
      if (result.status === 'replay') return invalid(c);
      await Promise.allSettled(
        target.kind === 'session'
          ? result.sessions.map(({ id, userId }) =>
              deps.revoke.publish({ userId, applicationSessionId: id }),
            )
          : result.userIds.map((userId) => deps.revoke.publish({ userId })),
      );
      c.header('Cache-Control', 'no-store');
      return c.body(null, 200);
    },
  );
  return routes;
}
