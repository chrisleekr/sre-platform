import { afterEach, describe, expect, test, vi } from 'vitest';

import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED } from '@sre/contracts';

import { openIncidentSession } from '../session';

import { createFixture } from './session.fixture';

const __fixture = createFixture();

// Mirrors the clamp in session.ts: Node truncates any setTimeout delay above 2^31-1 to 1ms, so a
// deadline further out than this must be reached in hops rather than armed in one shot.
const MAX_TIMER_MS = 2_147_483_647;

const TICKET_PREFIX = 'ws:ticket:';
const TICKET_VERSION = 2;
const TICKET_TTL_SEC = 30;

// Same HKDF derivation the TicketStore uses, so this suite can forge a correctly-authenticated
// envelope and exercise a payload shape the mint path can no longer produce.
const TICKET_AUTH_KEY = Buffer.from(
  hkdfSync(
    'sha256',
    Buffer.from(__fixture.TICKET_MASTER_KEY, 'base64'),
    Buffer.alloc(0),
    Buffer.from('sre-platform/ws-ticket/v2', 'utf8'),
    32,
  ),
);

const storedTicketKeys = new Set<string>();

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (storedTicketKeys.size > 0) {
    await __fixture.redis.del(...storedTicketKeys);
    storedTicketKeys.clear();
  }
});

/** Write a hand-built envelope under a fresh handle, bypassing mint so the payload shape is ours. */
async function storeRawTicket(payload: string): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + TICKET_TTL_SEC * 1_000;
  const tag = createHmac('sha256', TICKET_AUTH_KEY)
    .update(JSON.stringify([TICKET_VERSION, ticket, payload, expiresAt]))
    .digest('base64url');
  const key = TICKET_PREFIX + ticket;
  storedTicketKeys.add(key);
  await __fixture.redis.set(
    key,
    JSON.stringify({ version: TICKET_VERSION, payload, expiresAt, tag }),
    'EX',
    TICKET_TTL_SEC,
  );
  return ticket;
}

describe('dashboard session token deadline', () => {
  test('closes the socket at the token expiry', async () => {
    const incidentId = await __fixture.freshIncident();
    // Take the first Postgres and Valkey round trips on REAL timers: a connect timeout scheduled
    // under fake timers would fire when the test jumps to the deadline. This leaves no warm pub/sub
    // connection behind, because hub.subscribe calls redis.duplicate() on every call and disconnects
    // that client on unsubscribe, so the session below still opens a subscriber of its own.
    const warmUnsubscribe = await __fixture.hub.subscribe(incidentId, () => {});
    await warmUnsubscribe();

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantA,
      sub: 'u',
      tokenExpiresAt: Date.now() + 60_000,
    });

    // Fake only the timer pair the expiry guard uses, and leave Date real so the deadline arithmetic
    // inside the session still reads a wall clock. shouldAdvanceTime keeps the live Postgres and
    // Valkey sockets progressing while the session opens.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
      advanceTimeDelta: 20,
    });

    const session = await openIncidentSession(__fixture.deps, {
      incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();
    expect(c.closed()).toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(c.closed()).toEqual([WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED]);

    vi.useRealTimers();
    await session!.close();
  }, 30_000);

  test('re-arms in hops for a deadline past the timer ceiling instead of closing at once', async () => {
    const incidentId = await __fixture.freshIncident();
    // Same real-timer warm-up as the test above, for the same reason.
    const warmUnsubscribe = await __fixture.hub.subscribe(incidentId, () => {});
    await warmUnsubscribe();

    const c = __fixture.collector();
    // More than one hop past the ceiling, so the first re-arm cannot be the last one. The mint site
    // multiplies the token's `exp` with no upper bound, so this is reachable from real input.
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantA,
      sub: 'u',
      tokenExpiresAt: Date.now() + MAX_TIMER_MS * 2 + 60_000,
    });

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
      advanceTimeDelta: 20,
    });

    const session = await openIncidentSession(__fixture.deps, {
      incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    // Without the clamp the raw delay overflows the signed 32-bit timer field and Node fires it after
    // 1ms, so every long-lived session would close on `token expired` right after opening. Advancing a
    // full ceiling proves the hop was armed at the clamp and that reaching it re-arms rather than fires.
    await vi.advanceTimersByTimeAsync(MAX_TIMER_MS);
    expect(c.closed()).toBeNull();
    // "Did not close early" alone is satisfied by a hop that schedules nothing, which would mean the
    // session never expires at all. Assert the successor timer exists, which the deleted-re-arm mutant
    // fails. The real-timer warm-up above keeps Postgres and Valkey timers out of this count.
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    vi.useRealTimers();
    await session!.close();
  }, 30_000);

  test('close() disarms the expiry timer so no late close reaches the released socket', async () => {
    const incidentId = await __fixture.freshIncident();
    // Same real-timer warm-up as the test above, for the same reason.
    const warmUnsubscribe = await __fixture.hub.subscribe(incidentId, () => {});
    await warmUnsubscribe();

    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantA,
      sub: 'u',
      tokenExpiresAt: Date.now() + 60_000,
    });

    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
      advanceTimeDelta: 20,
    });

    const session = await openIncidentSession(__fixture.deps, {
      incidentId,
      ticket,
      sink: c.sink,
    });
    expect(session).not.toBeNull();

    // A normal close releases the socket, so the still-pending expiry timer must go with it. Every
    // other test in the suite would stay green with the clear dropped, while leaking a timer that
    // later calls sink.close on a socket the session no longer owns.
    await session!.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(c.closed()).toBeNull();

    vi.useRealTimers();
  }, 30_000);

  test('refuses an already-expired ticket before reading the incident', async () => {
    const incidentId = await __fixture.freshIncident();
    const c = __fixture.collector();
    const { ticket } = await __fixture.mintTicket({
      tenantId: __fixture.tenantA,
      sub: 'u',
      tokenIssuedAt: Date.now() - 5_000,
      tokenExpiresAt: Date.now() - 1_000,
    });

    // getIncident -> withTenant -> appDb.transaction is the only channel the incident read has, so an
    // untouched spy proves the deadline was checked before any tenant row was read.
    const transaction = vi.spyOn(__fixture.deps.appDb, 'transaction');

    const session = await openIncidentSession(__fixture.deps, {
      incidentId,
      ticket,
      sink: c.sink,
    });

    expect(session).toBeNull();
    expect(c.closed()).toEqual([WS_CLOSE_POLICY, WS_CLOSE_TOKEN_EXPIRED]);
    expect(transaction).not.toHaveBeenCalled();
  }, 30_000);

  test('refuses a ticket envelope carrying no token deadline as an invalid ticket', async () => {
    const incidentId = await __fixture.freshIncident();
    const c = __fixture.collector();
    // A correctly-authenticated envelope whose payload predates the deadline field. Redemption must
    // fail outright rather than yield a session that never expires.
    const ticket = await storeRawTicket(JSON.stringify({ tenantId: __fixture.tenantA, sub: 'u' }));

    const session = await openIncidentSession(__fixture.deps, {
      incidentId,
      ticket,
      sink: c.sink,
    });

    expect(session).toBeNull();
    // A different reason from the expired-deadline close, so these two cannot pass for one reason.
    expect(c.closed()).toEqual([WS_CLOSE_POLICY, 'invalid ticket']);
  }, 30_000);
});
