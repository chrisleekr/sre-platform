import { randomBytes } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { expect, test } from 'vitest';
import {
  browserSessions,
  createBrowserSession,
  identityProviders,
  makePlatformSecretStore,
  memberships,
  tenants,
  users,
} from '@sre/db';
import { makeProviderVerifiers } from '../../auth/providers';
import type { AuthDeps } from '../../auth';
import { makeBrowserSessionRuntime } from '../../onboarding/browser-session-runtime';
import { browserSessionRoutes } from '../../onboarding/browser-session-routes';
import { ticketRoutes } from '../ticket';
import { openIncidentSession } from '../session';
import { createFixture } from './session.fixture';

const fixture = createFixture();

test.each(['logout', 'idle', 'absolute', 'cutoff', 'provider', 'membership', 'tenant'] as const)(
  'cookie session %s denies ticket redemption and live activity even without a revoke hint',
  async (change) => {
    const origin = 'http://dashboard.example.test';
    await fixture.admin.db
      .update(identityProviders)
      .set({ browserClientId: 'browser-client' })
      .where(eq(identityProviders.id, fixture.providerId));
    const [user] = await fixture.admin.db.select().from(users).where(eq(users.id, fixture.userA));
    const created = await createBrowserSession(fixture.admin.db, {
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
    const auth: AuthDeps = {
      db: fixture.app.db,
      adminDb: fixture.admin.db,
      verifiers: makeProviderVerifiers(fixture.app.db),
      settings: { get: async () => 86400 },
      revoke: { publish: async () => {} },
    };
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
    const headers = { cookie: `sre-session=${created.credential}`, origin, 'x-sre-session': '1' };
    const mint = async () => {
      const response = await api.request('/ws/ticket', { method: 'POST', headers });
      expect(response.status).toBe(200);
      return ((await response.json()) as { ticket: string }).ticket;
    };
    const inspected = await fixture.tickets.redeem(await mint());
    expect(inspected?.applicationSessionId).toBe(created.session.id);
    const incidentId = await fixture.freshIncident();
    const readerSink = fixture.collector();
    const writerSink = fixture.collector();
    const reader = await openIncidentSession(fixture.deps, {
      incidentId,
      ticket: await mint(),
      sink: readerSink.sink,
    });
    const writer = await openIncidentSession(fixture.deps, {
      incidentId,
      ticket: await mint(),
      sink: writerSink.sink,
    });
    const outstanding = await mint();
    expect(reader).not.toBeNull();
    expect(writer).not.toBeNull();
    try {
      const past = new Date(Date.now() - 1000);
      if (change === 'logout')
        expect(
          (await api.request('/auth/browser/logout', { method: 'POST', headers })).status,
        ).toBe(200);
      else if (change === 'idle')
        await fixture.admin.db
          .update(browserSessions)
          .set({ idleExpiresAt: past })
          .where(eq(browserSessions.id, created.session.id));
      else if (change === 'absolute')
        await fixture.admin.db
          .update(browserSessions)
          .set({ idleExpiresAt: past, absoluteExpiresAt: past })
          .where(eq(browserSessions.id, created.session.id));
      else if (change === 'cutoff')
        await fixture.admin.db
          .update(users)
          .set({ notBefore: new Date(Date.now() + 1000) })
          .where(eq(users.id, fixture.userA));
      else if (change === 'provider')
        await fixture.admin.db
          .update(identityProviders)
          .set({ status: 'disabled' })
          .where(eq(identityProviders.id, fixture.providerId));
      else if (change === 'membership')
        await fixture.admin.db
          .update(memberships)
          .set({ status: 'removed' })
          .where(
            and(eq(memberships.userId, fixture.userA), eq(memberships.tenantId, fixture.tenantA)),
          );
      else
        await fixture.admin.db
          .update(tenants)
          .set({ status: 'suspended' })
          .where(eq(tenants.id, fixture.tenantA));
      expect(
        (await api.request('/ws/ticket', { method: 'POST', headers })).status,
      ).toBeGreaterThanOrEqual(400);
      const rejected = fixture.collector();
      expect(
        await openIncidentSession(fixture.deps, {
          incidentId,
          ticket: outstanding,
          sink: rejected.sink,
        }),
      ).toBeNull();
      expect(rejected.closed()).toEqual([1008, 'signed out']);
      const history = await fixture.hub.history(fixture.tenantA, incidentId);
      await expect(writer!.adapter.ingest({ content: 'must not persist' })).rejects.toMatchObject({
        code: 'session_closed',
      });
      expect(await fixture.hub.history(fixture.tenantA, incidentId)).toEqual(history);
      await fixture.hub.append(fixture.tenantA, incidentId, {
        author: 'system',
        content: 'must not reach revoked session',
      });
      await expect.poll(() => readerSink.closed()).toEqual([1008, 'signed out']);
      expect(readerSink.messages()).not.toContainEqual(
        expect.objectContaining({ content: 'must not reach revoked session' }),
      );
    } finally {
      await Promise.all([reader?.close(), writer?.close()]);
      await fixture.admin.db
        .update(identityProviders)
        .set({ status: 'active' })
        .where(eq(identityProviders.id, fixture.providerId));
      await fixture.admin.db
        .update(users)
        .set({ notBefore: null })
        .where(eq(users.id, fixture.userA));
      await fixture.admin.db
        .update(memberships)
        .set({ status: 'active' })
        .where(
          and(eq(memberships.userId, fixture.userA), eq(memberships.tenantId, fixture.tenantA)),
        );
      await fixture.admin.db
        .update(tenants)
        .set({ status: 'active' })
        .where(eq(tenants.id, fixture.tenantA));
    }
  },
);
