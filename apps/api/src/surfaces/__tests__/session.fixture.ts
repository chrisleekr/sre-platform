import { seedMembership } from '@sre/db/test-support';
import {
  createIncident,
  incidentMessages,
  incidents,
  jobs,
  makeDb,
  memberships,
  tenants,
  users,
  identityProviders,
  tenantIdentityBindings,
  type DbHandle,
} from '@sre/db';
import { ConversationHub, type HubMessage } from '@sre/hub';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll } from 'vitest';
import { type SessionDeps, type SessionSink } from '../session';
import { TicketStore, type TicketContext } from '../ticket';
import { SessionRegistry } from '../../auth/revoke';

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379';

  const TICKET_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');

  let admin: DbHandle;

  let app: DbHandle;

  let redis: Redis;

  let hub: ConversationHub;

  const setLifecycle = (tenantId: string, incidentId: string, to: 'resolved' | 'closed') =>
    hub.transitionIncident(tenantId, incidentId, {
      to,
      reason: 'Test fixture lifecycle.',
      transitionKey: `test:${incidentId}:${to}`,
      author: 'system',
    });

  let tickets: TicketStore;

  let deps: SessionDeps;

  let tenantA: string;

  let tenantB: string;

  let incidentId: string;

  let userA: string;

  let userB: string;

  // Records resume jobs the ingest enqueues, so tests assert the trigger without a live stream.
  const enqueued: { tenantId: string; incidentId: string; humanMessageId: string }[] = [];

  // Distinctive issuer for members this suite seeds, so afterAll can clean them deterministically.
  const SEED_ISSUER = `https://session-${randomUUID()}.invalid`;
  const providerId = randomUUID();

  function collector(): {
    sink: SessionSink;
    messages: () => HubMessage[];
    closed: () => [number, string] | null;
  } {
    const out: HubMessage[] = [];
    let closedWith: [number, string] | null = null;
    return {
      sink: {
        send: (d) => out.push(JSON.parse(d) as HubMessage),
        close: (code, reason) => {
          closedWith = [code, reason];
        },
      },
      messages: () => out,
      closed: () => closedWith,
    };
  }

  // A per-test incident: the status gates mutate incident status, so tests that do must not share
  // the suite-wide `incidentId` — a mutated status would poison every later test.
  async function freshIncident(): Promise<string> {
    const { id } = await createIncident(app.db, tenantA, {
      fingerprint: `fp-${randomUUID()}`,
      alertSource: 'datadog',
      service: 'checkout',
      severity: 'sev2',
    });
    return id;
  }

  // A session now closes at its token deadline. Every fixture ticket therefore carries a REAL
  // future deadline rather than a sentinel, so each existing session test keeps arming a real expiry
  // timer and no test can quietly opt out of the guard the session enforces.
  const DEFAULT_TOKEN_LIFETIME_MS = 3_600_000;

  /**
   * Mint a WS ticket for a session test. Callers pass the identity fields only; the token deadline
   * defaults to an hour out and is overridden only by tests whose subject IS the deadline.
   */
  function mintTicket(
    context: Omit<TicketContext, 'providerId' | 'userId' | 'tokenIssuedAt' | 'tokenExpiresAt'> &
      Partial<Pick<TicketContext, 'providerId' | 'userId' | 'tokenIssuedAt' | 'tokenExpiresAt'>>,
  ): Promise<{ ticket: string; expiresIn: number }> {
    const { userId, tokenIssuedAt, tokenExpiresAt, ...identity } = context;
    const issuedAt = tokenIssuedAt ?? Date.now() - 1_000;
    return tickets.mint({
      providerId,
      ...identity,
      userId: userId ?? (context.tenantId === tenantB ? userB : userA),
      tokenIssuedAt: issuedAt,
      tokenExpiresAt: tokenExpiresAt ?? Date.now() + DEFAULT_TOKEN_LIFETIME_MS,
    });
  }

  async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!fn()) {
      if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    redis = new Redis(VALKEY_URL, { maxRetriesPerRequest: null });
    hub = new ConversationHub(app.db, redis);
    tickets = new TicketStore(redis, 30, TICKET_MASTER_KEY);
    const sessionRegistry = new SessionRegistry();
    deps = {
      appDb: app.db,
      hub,
      tickets,
      sessionRegistry,
      queue: {
        insertResumeTx: async (_tx, tenantId, incId, humanMessageId) => {
          enqueued.push({ tenantId, incidentId: incId, humanMessageId });
          return { jobId: `job-${enqueued.length}` };
        },
        publishResume: async () => {},
      },
    };

    tenantA = randomUUID();
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
    await admin.db.insert(identityProviders).values({
      id: providerId,
      displayName: 'Session directory',
      issuer: SEED_ISSUER,
      jwksUri: `${SEED_ISSUER}/jwks`,
      audience: 'session-api',
      kind: 'oidc',
      scope: 'installation',
      status: 'active',
      tenantClaim: 'org_id',
    });
    await admin.db.insert(tenantIdentityBindings).values([
      { tenantId: tenantA, providerId, claimValue: tenantA },
      { tenantId: tenantB, providerId, claimValue: tenantB },
    ]);
    userA = await seedMembership(
      admin.db,
      { issuer: SEED_ISSUER, subject: `default-a-${randomUUID()}` },
      tenantA,
    );
    userB = await seedMembership(
      admin.db,
      { issuer: SEED_ISSUER, subject: `default-b-${randomUUID()}` },
      tenantB,
    );
    incidentId = (
      await createIncident(app.db, tenantA, {
        fingerprint: `fp-${randomUUID()}`,
        alertSource: 'datadog',
        service: 'checkout',
        severity: 'sev2',
      })
    ).id;
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(incidentMessages).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(incidents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      // Seeded members FK into tenants, so drop them before the tenants they reference. Scope
      // the user delete to THIS fixture's own members: every suite built on this fixture shares
      // SEED_ISSUER, so an issuer-wide delete tears out a concurrently running file's live rows and
      // fails on their still-present memberships.
      const seeded = await admin.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      const seededUserIds = seeded.map((row) => row.userId);
      if (seededUserIds.length > 0) {
        await admin.db
          .delete(users)
          .where(and(eq(users.issuer, SEED_ISSUER), inArray(users.id, seededUserIds)));
      }
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
      await admin.close();
    }
    if (app) await app.close();
    if (redis) await redis.quit();
  });

  return {
    ADMIN_URL,
    APP_URL,
    VALKEY_URL,
    TICKET_MASTER_KEY,
    providerId,
    get admin() {
      return admin;
    },
    set admin(value: typeof admin) {
      admin = value;
    },
    get app() {
      return app;
    },
    set app(value: typeof app) {
      app = value;
    },
    get redis() {
      return redis;
    },
    set redis(value: typeof redis) {
      redis = value;
    },
    get hub() {
      return hub;
    },
    set hub(value: typeof hub) {
      hub = value;
    },
    setLifecycle,
    get tickets() {
      return tickets;
    },
    set tickets(value: typeof tickets) {
      tickets = value;
    },
    get deps() {
      return deps;
    },
    set deps(value: typeof deps) {
      deps = value;
    },
    get tenantA() {
      return tenantA;
    },
    set tenantA(value: typeof tenantA) {
      tenantA = value;
    },
    get tenantB() {
      return tenantB;
    },
    set tenantB(value: typeof tenantB) {
      tenantB = value;
    },
    get incidentId() {
      return incidentId;
    },
    set incidentId(value: typeof incidentId) {
      incidentId = value;
    },
    get userA() {
      return userA;
    },
    get userB() {
      return userB;
    },
    enqueued,
    SEED_ISSUER,
    collector,
    freshIncident,
    mintTicket,
    waitFor,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
