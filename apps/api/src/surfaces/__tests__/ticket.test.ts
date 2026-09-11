import { seedMembership } from '@sre/db/test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import {
  SignJWT,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  createLocalJWKSet,
  type JSONWebKeySet,
} from 'jose';
import { Redis } from 'ioredis';
import {
  makeDb,
  tenantIdentityBindings,
  tenants,
  memberships,
  users,
  type DbHandle,
} from '@sre/db';
import type { AuthDeps } from '../../auth';
import { makeTestAuth } from '../../__tests__/auth-test-support';
import { TicketStore, ticketRoutes, type TicketContext } from '../ticket';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';
const ISSUER = 'https://test.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'ticket-key';
const TICKET_PREFIX = 'ws:ticket:';
const TICKET_TTL_SEC = 30;
const MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
const TICKET_AUTH_KEY = Buffer.from(
  hkdfSync(
    'sha256',
    Buffer.from(MASTER_KEY, 'base64'),
    Buffer.alloc(0),
    Buffer.from('sre-platform/ws-ticket/v2', 'utf8'),
    32,
  ),
);

let admin: DbHandle;
let app: DbHandle;
let redis: Redis;
let tickets: TicketStore;
let routes: ReturnType<typeof ticketRoutes>;
let privateKey: CryptoKey;
let orgId: string;
let tenantId: string;
let userId: string;
const cleanupKeys = new Set<string>();

interface TestEnvelope {
  version: number;
  payload: string;
  expiresAt: number;
  tag: string;
}

function redisKey(ticket: string): string {
  return TICKET_PREFIX + ticket;
}

function randomTicket(): string {
  return randomBytes(32).toString('base64url');
}

function authenticatedEnvelope(
  ticket: string,
  payload: string,
  version = 2,
  expiresAt = Date.now() + TICKET_TTL_SEC * 1_000,
): TestEnvelope {
  const tag = createHmac('sha256', TICKET_AUTH_KEY)
    .update(JSON.stringify([version, ticket, payload, expiresAt]))
    .digest('base64url');
  return { version, payload, expiresAt, tag };
}

async function mintTracked(
  store: TicketStore,
  context: TicketContext,
): Promise<{ ticket: string; expiresIn: number }> {
  const minted = await store.mint(context);
  cleanupKeys.add(redisKey(minted.ticket));
  return minted;
}

async function readRaw(ticket: string): Promise<string> {
  const raw = await redis.get(redisKey(ticket));
  expect(raw).not.toBeNull();
  return raw!;
}

async function setRaw(ticket: string, raw: string, ttlSec = TICKET_TTL_SEC): Promise<void> {
  const key = redisKey(ticket);
  cleanupKeys.add(key);
  await redis.set(key, raw, 'EX', ttlSec);
}

function replaceStoredContext(raw: string, replacement: TicketContext): string {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if ('payload' in parsed)
    return JSON.stringify({ ...parsed, payload: JSON.stringify(replacement) });
  return JSON.stringify(replacement);
}

async function expectRawCasesRejected(
  cases: { label: string; raw: (ticket: string) => string }[],
): Promise<void> {
  const results: { label: string; outcome: 'returned' | 'threw'; value?: unknown }[] = [];
  for (const fixture of cases) {
    const ticket = randomTicket();
    await setRaw(ticket, fixture.raw(ticket));
    try {
      results.push({
        label: fixture.label,
        outcome: 'returned',
        value: await tickets.redeem(ticket),
      });
    } catch {
      results.push({ label: fixture.label, outcome: 'threw' });
    }
  }
  expect(results).toEqual(cases.map(({ label }) => ({ label, outcome: 'returned', value: null })));
}

function sign(org: string): Promise<string> {
  // The old `org` argument is now the token subject; the fixture creates its provider binding.
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

/** A token that cannot say when it expires; the mint route must refuse it before minting. */
function signWithoutExp(org: string): Promise<string> {
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .sign(privateKey);
}

/**
 * A real future session deadline. Every inline context below carries one so the cases that test
 * some OTHER defect keep failing for their own named reason, not vacuously on the missing deadline.
 */
function futureDeadline(): number {
  return Date.now() + 3_600_000;
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
  tickets = new TicketStore(redis, TICKET_TTL_SEC, MASTER_KEY);

  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  orgId = `org_${randomUUID().slice(0, 8)}`;
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'T' });
  userId = await seedMembership(admin.db, { issuer: ISSUER, subject: orgId }, tenantId);
  const auth: AuthDeps = await makeTestAuth({
    adminDb: admin.db,
    appDb: app.db,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys,
    bindings: [{ tenantId, subject: orgId }],
  });
  routes = ticketRoutes({ auth, tickets });
}, 30_000);

afterEach(async () => {
  if (!redis || cleanupKeys.size === 0) return;
  await redis.del(...cleanupKeys);
  cleanupKeys.clear();
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(memberships).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject = ${orgId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
  if (redis) await redis.quit();
});

describe('WS ticket mint', () => {
  test('an unauthenticated mint is rejected', async () => {
    expect((await routes.request('/ticket', { method: 'POST' })).status).toBe(401);
  });

  test('an authenticated mint returns a single-use ticket scoped to the caller tenant', async () => {
    const res = await routes.request('/ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${await sign(orgId)}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string; expiresIn: number };
    expect(typeof body.ticket).toBe('string');
    expect(body.expiresIn).toBeGreaterThan(0);

    expect(await tickets.redeem(body.ticket)).toMatchObject({ tenantId, sub: orgId, userId });
    expect(await tickets.redeem(body.ticket)).toBeNull();
  });

  test('a mint presenting a token with no exp is rejected and yields no ticket', async () => {
    const res = await routes.request('/ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${await signWithoutExp(orgId)}` },
    });
    expect(res.status).toBe(401);
    // toEqual, not toMatchObject: it also proves the body carries no `ticket` to connect with.
    expect(await res.json()).toEqual({ error: 'token missing exp or iat' });
  });

  test('the minted ticket carries the token expiry as the session deadline', async () => {
    const token = await sign(orgId);
    const res = await routes.request('/ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ticket: string };
    cleanupKeys.add(redisKey(body.ticket));

    // The token's `exp` is in seconds; the ticket deadline is in milliseconds.
    expect(await tickets.redeem(body.ticket)).toMatchObject({
      tenantId,
      sub: orgId,
      userId,
      tokenIssuedAt: decodeJwt(token).iat! * 1_000,
      tokenExpiresAt: decodeJwt(token).exp! * 1_000,
    });
  });
});

describe('TicketStore authenticated records', () => {
  const legitimateContext = (): TicketContext => ({
    providerId: 'test-provider',
    tenantId,
    sub: orgId,
    userId,
    tokenIssuedAt: Date.now() - 1_000,
    tokenExpiresAt: futureDeadline(),
  });

  test('rejects same-handle raw context replacement', async () => {
    const { ticket } = await mintTracked(tickets, legitimateContext());
    const raw = await readRaw(ticket);
    const attackerContext = {
      providerId: 'attacker-provider',
      tenantId: randomUUID(),
      sub: 'attacker-subject',
      userId: randomUUID(),
      tokenIssuedAt: Date.now() - 1_000,
      tokenExpiresAt: futureDeadline(),
    };

    await setRaw(ticket, replaceStoredContext(raw, attackerContext));

    await expect(tickets.redeem(ticket)).resolves.toBeNull();
  });

  test('rejects an untouched raw record copied to a different 32-byte ticket handle', async () => {
    const { ticket } = await mintTracked(tickets, legitimateContext());
    const raw = await readRaw(ticket);
    const copiedTicket = randomTicket();

    await setRaw(copiedTicket, raw);
    expect(await redis.get(redisKey(copiedTicket))).toBe(raw);

    await expect(tickets.redeem(copiedTicket)).resolves.toBeNull();
  });

  test('rejects an embedded-expired ticket whose Redis TTL was extended', async () => {
    const shortLivedTickets = new TicketStore(redis, 1, MASTER_KEY);
    const { ticket } = await mintTracked(shortLivedTickets, legitimateContext());
    const raw = await readRaw(ticket);

    await setRaw(ticket, raw, 60);
    await delay(1_200);
    expect(await redis.get(redisKey(ticket))).toBe(raw);

    await expect(shortLivedTickets.redeem(ticket)).resolves.toBeNull();
  });

  test('returns null without throwing for an unsupported envelope version', async () => {
    await expectRawCasesRejected([
      {
        label: 'version 1 with an otherwise valid tag',
        raw: (ticket) =>
          JSON.stringify(authenticatedEnvelope(ticket, JSON.stringify(legitimateContext()), 1)),
      },
    ]);
  });

  test('returns null without throwing for malformed envelopes and payloads', async () => {
    await expectRawCasesRejected([
      { label: 'non-JSON envelope', raw: () => '{' },
      {
        label: 'missing envelope fields',
        raw: () => JSON.stringify({ version: 2, payload: JSON.stringify(legitimateContext()) }),
      },
      {
        label: 'non-object payload with a valid tag',
        raw: (ticket) =>
          JSON.stringify(authenticatedEnvelope(ticket, JSON.stringify(['not', 'a', 'context']))),
      },
    ]);
  });

  test('returns null without throwing for wrong-length and invalid tags', async () => {
    await expectRawCasesRejected([
      {
        label: '31-byte tag',
        raw: (ticket) =>
          JSON.stringify({
            ...authenticatedEnvelope(ticket, JSON.stringify(legitimateContext())),
            tag: Buffer.alloc(31, 1).toString('base64url'),
          }),
      },
      {
        label: 'wrong 32-byte tag',
        raw: (ticket) =>
          JSON.stringify({
            ...authenticatedEnvelope(ticket, JSON.stringify(legitimateContext())),
            tag: Buffer.alloc(32, 2).toString('base64url'),
          }),
      },
    ]);
  });

  test('returns null without throwing for a missing or non-positive session deadline', async () => {
    // A ticket without a usable deadline is a deadline-free session; redeem must refuse it
    // rather than hand back a context the session would never expire.
    await expectRawCasesRejected([
      {
        label: 'missing tokenExpiresAt',
        raw: (ticket) => {
          const { tokenExpiresAt: _omitted, ...withoutExpiry } = legitimateContext();
          return JSON.stringify(authenticatedEnvelope(ticket, JSON.stringify(withoutExpiry)));
        },
      },
      {
        label: 'zero tokenExpiresAt',
        raw: (ticket) =>
          JSON.stringify(
            authenticatedEnvelope(
              ticket,
              JSON.stringify({ ...legitimateContext(), tokenExpiresAt: 0 }),
            ),
          ),
      },
    ]);
  });

  test('requires a user id and an ordered protected-token lifetime', async () => {
    await expectRawCasesRejected([
      {
        label: 'missing userId',
        raw: (ticket) => {
          const { userId: _omitted, ...withoutUser } = legitimateContext();
          return JSON.stringify(authenticatedEnvelope(ticket, JSON.stringify(withoutUser)));
        },
      },
      {
        label: 'missing tokenIssuedAt',
        raw: (ticket) => {
          const { tokenIssuedAt: _omitted, ...withoutIssuedAt } = legitimateContext();
          return JSON.stringify(authenticatedEnvelope(ticket, JSON.stringify(withoutIssuedAt)));
        },
      },
      {
        label: 'issue time at expiry',
        raw: (ticket) => {
          const context = legitimateContext();
          return JSON.stringify(
            authenticatedEnvelope(
              ticket,
              JSON.stringify({ ...context, tokenIssuedAt: context.tokenExpiresAt }),
            ),
          );
        },
      },
    ]);
  });

  test('returns null without throwing for invalid context field types', async () => {
    await expectRawCasesRejected([
      {
        label: 'numeric tenantId',
        raw: (ticket) =>
          JSON.stringify(
            authenticatedEnvelope(ticket, JSON.stringify({ ...legitimateContext(), tenantId: 42 })),
          ),
      },
      {
        label: 'array sub',
        raw: (ticket) =>
          JSON.stringify(
            authenticatedEnvelope(ticket, JSON.stringify({ ...legitimateContext(), sub: [orgId] })),
          ),
      },
      {
        label: 'boolean userId',
        raw: (ticket) =>
          JSON.stringify(
            authenticatedEnvelope(
              ticket,
              JSON.stringify({
                ...legitimateContext(),
                userId: true,
              }),
            ),
          ),
      },
    ]);
  });
});
