import { seedMembership } from '@sre/db/test-support';
import * as dbExports from '@sre/db';
import {
  inboundChannels,
  jobs,
  makeDb,
  makeSecretStore,
  memberships,
  surfaceConfigs,
  surfaceInboundEvents,
  tenantSecrets,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
  type SecretStore,
} from '@sre/db';
import type { FetchLike } from '@sre/surfaces';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect } from 'vitest';
import type { Logger } from '../logger';
import type { AuthDeps } from '../auth';
// Router under test.
import { surfaceRoutes } from '../surface-config';
import { makeTestAuth } from './auth-test-support';

/** One fake Slack endpoint: a JSON body, or a throw standing in for a transport error / abort timeout. */
type SlackRoute = { body: unknown } | { throws: string };

/** The per-tenant channel cache seam. `get` returning null is a MISS — distinct from a
 *  legitimately empty channel list, which must still be served from the cache. */
interface CachedChannels {
  channels: { id: string; name: string }[];
  truncated: boolean;
}

interface ChannelsCacheLike {
  get(tenantId: string, token: string): Promise<CachedChannels | null>;
  set(tenantId: string, token: string, value: CachedChannels, ttlSec: number): Promise<void>;
}

interface SlackSocketLifecycle {
  replace(configId: string, appToken: string, appId: string): Promise<void>;
  stop(configId: string): Promise<void>;
  status?(configId: string): {
    state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
    connectedAt: string | null;
    updatedAt: string;
  };
}

interface PutSurfaceBody {
  botUserId?: string | null;
  botToken?: string;
  appToken?: string;
}

interface SanitizedSurface {
  id: string;
  surface: string;
  botUserId: string | null;
  hasBotToken: boolean;
  hasAppToken: boolean;
  runtime?: {
    socket: { state: string } | null;
    inbound: {
      latest: { state: string; jobStatus: string | null; attemptCount: number } | null;
      pendingCount: number;
      failedLast24Hours: number;
    } | null;
  };
}

export function createFixture() {
  const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';

  const APP_URL =
    process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

  const ISSUER = 'https://test.auth0.local/';

  const AUDIENCE = 'sre-api';

  const KID = 'test-key';

  const KEY = Buffer.alloc(32, 11).toString('base64');

  const TEST_APP_ID = 'A0SRETEST';

  const validAppToken = (label: string, appId = TEST_APP_ID): string =>
    `xapp-1-${appId}-${label.replace(/[^A-Za-z0-9]/g, '') || 'token'}-secret`;

  let admin: DbHandle;

  let app: DbHandle;

  let secrets: SecretStore;

  let privateKey: CryptoKey;

  let authKeys: ReturnType<typeof createLocalJWKSet>;

  let auth: AuthDeps;

  let orgA: string;

  let tenantA: string;

  let orgB: string;

  let tenantB: string;

  function sign(org: string): Promise<string> {
    return new SignJWT({ sub: org })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  }

  function authH(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` };
  }

  function bearer(token: string): { authorization: string; 'content-type': string } {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  /** Records each call (url, headers, raw body) and answers with a fixed HTTP + JSON body. Mirrors the
   *  fakeFetch pattern in packages/surfaces/src/__tests__/slack.test.ts. */
  function fakeFetch(
    result: unknown,
    ok = true,
    status = 200,
  ): {
    fetch: FetchLike;
    calls: { url: string; headers: Record<string, string>; body?: string }[];
  } {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
      return { ok, status, json: async () => result };
    };
    return { fetch, calls };
  }

  /** Like fakeFetch, but answers a QUEUE of bodies (one per call, the last repeating) so a paginated
   *  conversations.list can hand back page 1 then page 2. fakeFetch's fixed body cannot express that. */
  function queuedFetch(bodies: unknown[]): {
    fetch: FetchLike;
    calls: { url: string; headers: Record<string, string> }[];
  } {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetch: FetchLike = async (url, init) => {
      const body = bodies[Math.min(calls.length, bodies.length - 1)];
      calls.push({ url, headers: init?.headers ?? {} });
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetch, calls };
  }

  /** Answers per Slack METHOD instead of per call index. The scope probe makes TWO different calls in
   *  one request (auth.test, then users.info on the bot it just discovered) and each test needs them to
   *  answer DIFFERENTLY — which fakeFetch's single body cannot express, and queuedFetch's positional bodies
   *  can only express by baking in a call order the route is free to change. An UNROUTED method throws
   *  loudly rather than answering a default body: a probe that hits an unexpected endpoint must fail its
   *  test, never pass on a fallback. */
  function methodFetch(routes: Record<string, SlackRoute>): {
    fetch: FetchLike;
    calls: { url: string; headers: Record<string, string>; body?: string }[];
  } {
    const calls: { url: string; headers: Record<string, string>; body?: string }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers ?? {}, body: init?.body });
      const method = new URL(url).pathname.split('/').pop() ?? '';
      const route =
        routes[method] ??
        (method === 'bots.info'
          ? { body: { ok: true, bot: { app_id: TEST_APP_ID } } }
          : method === 'apps.connections.open'
            ? { body: { ok: true, url: 'wss://wss-primary.slack.test/link' } }
            : undefined);
      if (!route) throw new Error(`unrouted Slack method: ${method}`);
      if ('throws' in route) throw new Error(route.throws);
      const body =
        method === 'auth.test' &&
        route.body &&
        typeof route.body === 'object' &&
        (route.body as { ok?: boolean }).ok &&
        !('bot_id' in route.body)
          ? { ...(route.body as Record<string, unknown>), bot_id: 'B0SRETEST' }
          : route.body;
      return { ok: true, status: 200, json: async () => body };
    };
    return { fetch, calls };
  }

  /** Did the request reach users.info, and with what? The probe subject must be the bot auth.test already
   *  discovered, so accept it on the query string (the slackUsersInfoEmail precedent) or in a POST body. */
  function usersInfoProbe(
    calls: { url: string; headers: Record<string, string>; body?: string }[],
  ): { url: string; headers: Record<string, string>; body?: string } | undefined {
    return calls.find((c) => c.url.includes('/users.info'));
  }

  /** An in-memory ChannelsCache double: real per-tenant + per-TOKEN keying, no Valkey. Records every set so
   * a test can prove a FAILED Slack call was never cached. `faults` makes get/set throw, standing
   *  in for a Valkey outage — which the route must treat as a MISS, never as a failure of its own. */
  function fakeChannelsCache(faults?: { get?: boolean; set?: boolean }): ChannelsCacheLike & {
    sets: { tenantId: string; value: CachedChannels }[];
  } {
    const store = new Map<string, CachedChannels>();
    const sets: { tenantId: string; value: CachedChannels }[] = [];
    const key = (tenantId: string, token: string): string => `${tenantId}:${token}`;
    return {
      sets,
      async get(tenantId, token) {
        if (faults?.get) throw new Error('valkey down');
        return store.get(key(tenantId, token)) ?? null;
      },
      async set(tenantId, token, value) {
        if (faults?.set) throw new Error('valkey down');
        store.set(key(tenantId, token), value);
        sets.push({ tenantId, value });
      },
    };
  }

  /** Mounts the surface router at /surfaces with an injected fetch for Slack API validation.
   *  Endpoints that never call out use the default (never-invoked) fetch.
   * `channels` injects the available-channels cache; omitted, the route must still work. */
  function makeSurfaceApp(
    fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
    channels?: ChannelsCacheLike,
    slackSockets?: SlackSocketLifecycle,
    log?: Logger,
  ): Hono {
    const h = new Hono();
    h.route(
      '/surfaces',
      surfaceRoutes({
        auth,
        db: app.db,
        adminDb: admin.db,
        secrets,
        fetch: fetchImpl,
        // Forward-referenced optional dep: typed once SurfaceRoutesDeps gains `channels`.
        channels,
        slackSockets,
        log,
      } as unknown as Parameters<typeof surfaceRoutes>[0]),
    );
    return h;
  }

  async function putSurface(
    org: string,
    surface: string,
    body: PutSurfaceBody,
    fetchImpl?: FetchLike,
  ): Promise<Response> {
    return makeSurfaceApp(fetchImpl).request(`/surfaces/${surface}`, {
      method: 'PUT',
      headers: bearer(await sign(org)),
      body: JSON.stringify(body),
    });
  }

  function putSlack(org: string, body: PutSurfaceBody): Promise<Response> {
    const botUserId = body.botUserId ?? verifiedBotByOrg.get(org) ?? `U${org.replace(/\W/g, '')}`;
    verifiedBotByOrg.set(org, botUserId);
    const appToken = body.appToken?.startsWith('xapp-1-')
      ? body.appToken
      : validAppToken(body.appToken ?? org);
    const appId = appToken.split('-')[2] ?? TEST_APP_ID;
    const { fetch } = methodFetch({
      'auth.test': {
        body: {
          ok: true,
          user_id: botUserId,
          bot_id: `B${org.replace(/\W/g, '')}`,
          team_id: `T${org.replace(/\W/g, '')}`,
        },
      },
      'bots.info': { body: { ok: true, bot: { app_id: appId } } },
      'apps.connections.open': { body: { ok: true, url: 'wss://wss-primary.slack.test/link' } },
      'users.info': { body: { ok: true, user: { id: botUserId } } },
    });
    return putSurface(org, 'slack', { ...body, appToken }, fetch);
  }

  const verifiedBotByOrg = new Map<string, string>();

  function slackAppTokenKey(): string {
    const builder = (dbExports as unknown as { surfaceAppTokenKey?: (surface: string) => string })
      .surfaceAppTokenKey;
    expect(builder).toBeTypeOf('function');
    return builder!('slack');
  }

  async function listSurfaces(org: string): Promise<SanitizedSurface[]> {
    const res = await makeSurfaceApp().request('/surfaces', { headers: authH(await sign(org)) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { surfaces: SanitizedSurface[] }).surfaces;
  }

  async function getSlack(org: string): Promise<SanitizedSurface | undefined> {
    return (await listSurfaces(org)).find((s) => s.surface === 'slack');
  }

  beforeAll(async () => {
    admin = makeDb(ADMIN_URL);
    app = makeDb(APP_URL);
    secrets = makeSecretStore(app.db, KEY);

    const kp = await generateKeyPair('RS256', { extractable: true });
    privateKey = kp.privateKey;
    const jwk = await exportJWK(kp.publicKey);
    jwk.kid = KID;
    jwk.alg = 'RS256';
    jwk.use = 'sig';
    authKeys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);

    orgA = `org_${randomUUID().slice(0, 8)}`;
    tenantA = randomUUID();
    orgB = `org_${randomUUID().slice(0, 8)}`;
    tenantB = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantA, name: 'A' },
      { id: tenantB, name: 'B' },
    ]);
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgA }, tenantA);
    await seedMembership(admin.db, { issuer: ISSUER, subject: orgB }, tenantB);
    auth = await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: authKeys,
      bindings: [
        { tenantId: tenantA, subject: orgA },
        { tenantId: tenantB, subject: orgB },
      ],
    });
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.db.delete(jobs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(surfaceInboundEvents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(inboundChannels).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(surfaceConfigs).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(tenantSecrets).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db
        .delete(tenantIdentityBindings)
        .where(sql`tenant_id in (${tenantA}, ${tenantB})`);
      await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in (${orgA}, ${orgB})`);
      await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
      await admin.close();
    }
    if (app) await app.close();
  });

  return {
    ADMIN_URL,
    APP_URL,
    ISSUER,
    AUDIENCE,
    KID,
    KEY,
    TEST_APP_ID,
    validAppToken,
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
    get secrets() {
      return secrets;
    },
    set secrets(value: typeof secrets) {
      secrets = value;
    },
    get privateKey() {
      return privateKey;
    },
    set privateKey(value: typeof privateKey) {
      privateKey = value;
    },
    get authKeys() {
      return authKeys;
    },
    set authKeys(value: typeof authKeys) {
      authKeys = value;
    },
    get auth() {
      return auth;
    },
    set auth(value: typeof auth) {
      auth = value;
    },
    get orgA() {
      return orgA;
    },
    set orgA(value: typeof orgA) {
      orgA = value;
    },
    get tenantA() {
      return tenantA;
    },
    set tenantA(value: typeof tenantA) {
      tenantA = value;
    },
    get orgB() {
      return orgB;
    },
    set orgB(value: typeof orgB) {
      orgB = value;
    },
    get tenantB() {
      return tenantB;
    },
    set tenantB(value: typeof tenantB) {
      tenantB = value;
    },
    sign,
    authH,
    bearer,
    fakeFetch,
    queuedFetch,
    methodFetch,
    usersInfoProbe,
    fakeChannelsCache,
    makeSurfaceApp,
    putSurface,
    putSlack,
    verifiedBotByOrg,
    slackAppTokenKey,
    listSurfaces,
    getSlack,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
