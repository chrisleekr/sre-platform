import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import { createBrowserSession, identityProviders, makePlatformSecretStore, users } from '@sre/db';
import { makeProviderVerifiers } from '../../auth/providers';
import { makeRevokePublisher, SessionRegistry } from '../../auth/revoke';
import type { AuthDeps } from '../../auth';
import { makeBrowserSessionRuntime } from '../../onboarding/browser-session-runtime';
import { browserSessionRoutes } from '../../onboarding/browser-session-routes';
import { ticketRoutes } from '../ticket';
import { openIncidentSession } from '../session';
import { createFixture } from './session.fixture';

const fixture = createFixture();

test('logging out one browser closes only its sockets, while a user-wide revoke still closes every credential', async () => {
  await fixture.admin.db
    .update(identityProviders)
    .set({ browserClientId: 'browser-client' })
    .where(eq(identityProviders.id, fixture.providerId));
  const [user] = await fixture.admin.db.select().from(users).where(eq(users.id, fixture.userA));
  const create = () =>
    createBrowserSession(fixture.admin.db, {
      providerId: fixture.providerId,
      clientId: 'browser-client',
      userId: fixture.userA,
      foundingId: null,
      oidcSubject: user!.subject,
      bindingClaimValue: fixture.tenantA,
      authenticatedAt: new Date(),
      idleSeconds: 3600,
      absoluteSeconds: 86400,
    });
  const [first, second] = await Promise.all([create(), create()]);
  const registry = new SessionRegistry();
  await registry.start(fixture.redis.duplicate());
  const publisher = makeRevokePublisher(fixture.redis);
  const auth: AuthDeps = {
    db: fixture.app.db,
    adminDb: fixture.admin.db,
    verifiers: makeProviderVerifiers(fixture.app.db),
    settings: { get: async () => 86400 },
    revoke: publisher,
  };
  const origin = 'http://dashboard.example.test';
  const runtime = makeBrowserSessionRuntime({
    db: fixture.admin.db,
    auth,
    secrets: makePlatformSecretStore(fixture.admin.db, randomBytes(32).toString('base64')),
    dashboardUrl: origin,
    production: false,
    setting: async () => 86400,
    email: async () => null,
  });
  auth.browserSession = runtime.resolve;
  const api = new Hono().route('/ws', ticketRoutes({ auth, tickets: fixture.tickets })).route(
    '/',
    browserSessionRoutes(runtime, { allow: async () => true }, () => '203.0.113.1'),
  );
  const headers = (credential: string) => ({
    cookie: `sre-session=${credential}`,
    origin,
    'x-sre-session': '1',
  });
  async function mint(credential: string) {
    const response = await api.request('/ws/ticket', {
      method: 'POST',
      headers: headers(credential),
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { ticket: string }).ticket;
  }
  const sinks = [fixture.collector(), fixture.collector(), fixture.collector()];
  const tickets = [
    await mint(first.credential),
    await mint(second.credential),
    (await fixture.mintTicket({ tenantId: fixture.tenantA, sub: user!.subject })).ticket,
  ];
  const sessions = [];
  try {
    for (const [index, ticket] of tickets.entries()) {
      const session = await openIncidentSession(
        { ...fixture.deps, sessionRegistry: registry },
        { incidentId: fixture.incidentId, ticket, sink: sinks[index]!.sink },
      );
      expect(session).not.toBeNull();
      sessions.push(session);
    }
    expect(
      (
        await api.request('/auth/browser/logout', {
          method: 'POST',
          headers: headers(first.credential),
        })
      ).status,
    ).toBe(200);
    await expect.poll(() => sinks[0]!.closed()).toEqual([1008, 'signed out']);
    expect(sinks[1]!.closed()).toBeNull();
    expect(sinks[2]!.closed()).toBeNull();
    expect(
      (await api.request('/ws/ticket', { method: 'POST', headers: headers(first.credential) }))
        .status,
    ).toBe(401);
    await mint(second.credential);
    await publisher.publish({ userId: fixture.userA });
    await expect.poll(() => sinks[1]!.closed()).toEqual([1008, 'signed out']);
    await expect.poll(() => sinks[2]!.closed()).toEqual([1008, 'signed out']);
  } finally {
    for (const session of sessions) await session?.close();
    await registry.close();
  }
});
