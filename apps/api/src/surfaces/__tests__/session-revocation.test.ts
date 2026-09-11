import { seedMembership } from '@sre/db/test-support';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, test, vi } from 'vitest';
import {
  identityProviders,
  tenantIdentityBindings,
  memberships,
  setUserNotBefore,
  tenants,
  users,
  type Db,
} from '@sre/db';
import { IngestRefusedError, openIncidentSession, type SessionDeps } from '../session';
import { createFixture } from './session.fixture';

const fixture = createFixture();

describe('dashboard session revocation registration', () => {
  test.each(['disabled', 'directory-only', 'replacement'] as const)(
    'denies old tickets and live frames after %s authentication policy changes, without a revoke hint',
    async (change) => {
      const incidentId = await fixture.freshIncident();
      const read = fixture.collector();
      const write = fixture.collector();
      const mint = () => fixture.mintTicket({ tenantId: fixture.tenantA, sub: 'policy-change' });
      const reader = await openIncidentSession(fixture.deps, {
        incidentId,
        ticket: (await mint()).ticket,
        sink: read.sink,
      });
      const writer = await openIncidentSession(fixture.deps, {
        incidentId,
        ticket: (await mint()).ticket,
        sink: write.sink,
      });
      const oldTicket = await mint();
      const replacementId = randomUUID();
      expect(reader).not.toBeNull();
      expect(writer).not.toBeNull();
      try {
        if (change === 'directory-only') {
          await fixture.admin.db
            .update(tenants)
            .set({ requireDirectory: true })
            .where(eq(tenants.id, fixture.tenantA));
        } else {
          await fixture.admin.db
            .update(identityProviders)
            .set({ status: 'disabled' })
            .where(eq(identityProviders.id, fixture.providerId));
          if (change === 'replacement') {
            const [previous] = await fixture.admin.db
              .select()
              .from(identityProviders)
              .where(eq(identityProviders.id, fixture.providerId));
            await fixture.admin.db.insert(identityProviders).values({
              ...previous!,
              id: replacementId,
              status: 'active',
              audience: 'different-api',
            });
            await fixture.admin.db.insert(tenantIdentityBindings).values({
              tenantId: fixture.tenantA,
              providerId: replacementId,
              claimValue: fixture.tenantA,
            });
          }
        }
        const rejected = fixture.collector();
        expect(
          await openIncidentSession(fixture.deps, {
            incidentId,
            ticket: oldTicket.ticket,
            sink: rejected.sink,
          }),
        ).toBeNull();
        expect(rejected.closed()).toEqual([1008, 'signed out']);
        const before = await fixture.hub.history(fixture.tenantA, incidentId);
        await expect(writer!.adapter.ingest({ content: 'must not persist' })).rejects.toMatchObject(
          { code: 'session_closed' },
        );
        expect(await fixture.hub.history(fixture.tenantA, incidentId)).toHaveLength(before.length);
        await fixture.hub.append(fixture.tenantA, incidentId, {
          author: 'system',
          content: 'must not reach old method',
        });
        await expect.poll(() => read.closed()).toEqual([1008, 'signed out']);
        expect(read.messages()).not.toContainEqual(
          expect.objectContaining({ content: 'must not reach old method' }),
        );
      } finally {
        await Promise.all([reader?.close(), writer?.close()]);
        await fixture.admin.db
          .delete(tenantIdentityBindings)
          .where(eq(tenantIdentityBindings.providerId, replacementId));
        await fixture.admin.db
          .delete(identityProviders)
          .where(eq(identityProviders.id, replacementId));
        await fixture.admin.db
          .update(identityProviders)
          .set({ status: 'active' })
          .where(eq(identityProviders.id, fixture.providerId));
        await fixture.admin.db
          .update(tenants)
          .set({ requireDirectory: false })
          .where(eq(tenants.id, fixture.tenantA));
      }
    },
  );

  test('registers the authenticated user and deregisters exactly once on normal close', async () => {
    const incidentId = await fixture.freshIncident();
    const userId = fixture.userA;
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const deps = {
      ...fixture.deps,
      sessionRegistry: { register },
    } as SessionDeps & { sessionRegistry: { register: typeof register } };
    const { ticket } = await fixture.mintTicket({
      tenantId: fixture.tenantA,
      userId,
      sub: 'session-revocation-user',
    });

    const session = await openIncidentSession(deps, {
      incidentId,
      ticket,
      sink: fixture.collector().sink,
    });
    expect(session).not.toBeNull();
    expect(register).toHaveBeenCalledWith(userId, fixture.tenantA, expect.any(Function), undefined);

    await session!.close();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('rejects disabled, deleted, and already-revoked users before incident access', async () => {
    for (const state of ['disabled', 'deleted', 'revoked'] as const) {
      const incidentId = await fixture.freshIncident();
      const tokenIssuedAt = Date.now() - 5_000;
      const userId = await seedMembership(
        fixture.admin.db,
        { issuer: fixture.SEED_ISSUER, subject: `${state}-${randomUUID()}` },
        fixture.tenantA,
      );
      await fixture.admin.db
        .update(users)
        .set(
          state === 'revoked' ? { notBefore: new Date(tokenIssuedAt + 1_000) } : { status: state },
        )
        .where(eq(users.id, userId));
      const unregister = vi.fn();
      const register = vi.fn(() => unregister);
      const collector = fixture.collector();
      const { ticket } = await fixture.mintTicket({
        tenantId: fixture.tenantA,
        userId,
        sub: `${state}-session`,
        tokenIssuedAt,
      });

      const session = await openIncidentSession(
        { ...fixture.deps, sessionRegistry: { register } },
        { incidentId, ticket, sink: collector.sink },
      );
      expect(session).toBeNull();
      expect(collector.closed()).toEqual([1008, 'signed out']);
      expect(unregister).toHaveBeenCalledTimes(1);
    }
  });

  test('rejects suspended tenants and removed or missing memberships before incident access', async () => {
    const suspendedIncidentId = await fixture.freshIncident();
    await fixture.admin.db
      .update(tenants)
      .set({ status: 'suspended' })
      .where(eq(tenants.id, fixture.tenantA));
    try {
      const collector = fixture.collector();
      const { ticket } = await fixture.mintTicket({
        tenantId: fixture.tenantA,
        sub: 'suspended-tenant',
      });
      await expect(
        openIncidentSession(fixture.deps, {
          incidentId: suspendedIncidentId,
          ticket,
          sink: collector.sink,
        }),
      ).resolves.toBeNull();
      expect(collector.closed()).toEqual([1008, 'signed out']);
    } finally {
      await fixture.admin.db
        .update(tenants)
        .set({ status: 'active' })
        .where(eq(tenants.id, fixture.tenantA));
    }

    for (const membershipState of ['removed', 'missing'] as const) {
      const incidentId = await fixture.freshIncident();
      const userId = await seedMembership(
        fixture.admin.db,
        { issuer: fixture.SEED_ISSUER, subject: `${membershipState}-${randomUUID()}` },
        fixture.tenantA,
      );
      if (membershipState === 'removed') {
        await fixture.admin.db
          .update(memberships)
          .set({ status: 'removed' })
          .where(eq(memberships.userId, userId));
      } else {
        await fixture.admin.db.delete(memberships).where(eq(memberships.userId, userId));
      }
      const collector = fixture.collector();
      const { ticket } = await fixture.mintTicket({
        tenantId: fixture.tenantA,
        userId,
        sub: `${membershipState}-membership`,
      });
      await expect(
        openIncidentSession(fixture.deps, { incidentId, ticket, sink: collector.sink }),
      ).resolves.toBeNull();
      expect(collector.closed()).toEqual([1008, 'signed out']);
      if (membershipState === 'missing') {
        await fixture.admin.db.delete(users).where(eq(users.id, userId));
      }
    }
  });

  test('a revocation callback during open closes and deregisters the provisional session', async () => {
    const incidentId = await fixture.freshIncident();
    const unregister = vi.fn();
    const register = vi.fn(
      (_userId: string, _tenantId: string, close: (code: number, reason: string) => void) => {
        close(1008, 'signed out');
        return unregister;
      },
    );
    const collector = fixture.collector();
    const { ticket } = await fixture.mintTicket({ tenantId: fixture.tenantA, sub: 'opening' });

    await expect(
      openIncidentSession(
        { ...fixture.deps, sessionRegistry: { register } },
        { incidentId, ticket, sink: collector.sink },
      ),
    ).resolves.toBeNull();
    expect(collector.closed()).toEqual([1008, 'signed out']);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('a post-check revocation callback closes an open session with policy status', async () => {
    const incidentId = await fixture.freshIncident();
    const unregister = vi.fn();
    let revoke!: (code: number, reason: string) => void;
    const register = vi.fn(
      (_userId: string, _tenantId: string, close: (code: number, reason: string) => void) => {
        revoke = close;
        return unregister;
      },
    );
    const collector = fixture.collector();
    const { ticket } = await fixture.mintTicket({ tenantId: fixture.tenantA, sub: 'open' });
    const session = await openIncidentSession(
      { ...fixture.deps, sessionRegistry: { register } },
      { incidentId, ticket, sink: collector.sink },
    );
    expect(session).not.toBeNull();

    revoke(1008, 'signed out');

    expect(collector.closed()).toEqual([1008, 'signed out']);
    expect(unregister).toHaveBeenCalledTimes(1);
    const before = await fixture.hub.history(fixture.tenantA, incidentId);
    await expect(
      session!.adapter.ingest({ content: 'must not persist after revocation' }),
    ).rejects.toMatchObject({
      code: 'session_closed',
    } satisfies Partial<IngestRefusedError>);
    expect(await fixture.hub.history(fixture.tenantA, incidentId)).toHaveLength(before.length);
    await session!.close();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('durable removal denies open sockets when the revocation notification is missed', async () => {
    const incidentId = await fixture.freshIncident();
    const userId = await seedMembership(
      fixture.admin.db,
      { issuer: fixture.SEED_ISSUER, subject: `missed-revoke-${randomUUID()}` },
      fixture.tenantA,
    );
    const writeCollector = fixture.collector();
    const readCollector = fixture.collector();
    const { ticket: writeTicket } = await fixture.mintTicket({
      tenantId: fixture.tenantA,
      userId,
      sub: 'missed-revoke-write',
    });
    const { ticket: readTicket } = await fixture.mintTicket({
      tenantId: fixture.tenantA,
      userId,
      sub: 'missed-revoke-read',
    });
    const writeSession = await openIncidentSession(fixture.deps, {
      incidentId,
      ticket: writeTicket,
      sink: writeCollector.sink,
    });
    const readSession = await openIncidentSession(fixture.deps, {
      incidentId,
      ticket: readTicket,
      sink: readCollector.sink,
    });
    expect(writeSession).not.toBeNull();
    expect(readSession).not.toBeNull();

    await fixture.admin.db
      .update(memberships)
      .set({ status: 'removed' })
      .where(eq(memberships.userId, userId));
    const before = await fixture.hub.history(fixture.tenantA, incidentId);
    await expect(
      writeSession!.adapter.ingest({ content: 'must not persist after durable removal' }),
    ).rejects.toMatchObject({ code: 'session_closed' } satisfies Partial<IngestRefusedError>);
    expect(await fixture.hub.history(fixture.tenantA, incidentId)).toHaveLength(before.length);

    await fixture.hub.append(fixture.tenantA, incidentId, {
      author: 'system',
      content: 'must not reach the removed member',
    });
    await expect.poll(() => readCollector.closed()).toEqual([1008, 'signed out']);
    expect(readCollector.messages()).not.toContainEqual(
      expect.objectContaining({ content: 'must not reach the removed member' }),
    );
    await Promise.all([writeSession!.close(), readSession!.close()]);
  });

  test('expiry deregisters the session', async () => {
    const incidentId = await fixture.freshIncident();
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const collector = fixture.collector();
    const { ticket } = await fixture.mintTicket({
      tenantId: fixture.tenantA,
      sub: 'expiring',
      tokenExpiresAt: Date.now() + 1_000,
    });
    const session = await openIncidentSession(
      { ...fixture.deps, sessionRegistry: { register } },
      { incidentId, ticket, sink: collector.sink },
    );
    expect(session).not.toBeNull();

    await expect.poll(() => unregister.mock.calls.length, { timeout: 2_000 }).toBe(1);
    expect(collector.closed()).toEqual([1008, 'token expired']);
    await session!.close();
  });

  test('a durable-state dependency error closes and deregisters before propagating', async () => {
    const unregister = vi.fn();
    const register = vi.fn(() => unregister);
    const collector = fixture.collector();
    const { ticket } = await fixture.mintTicket({ tenantId: fixture.tenantA, sub: 'db-error' });
    const appDb = {
      select() {
        throw new Error('session state unavailable');
      },
    } as unknown as Db;

    await expect(
      openIncidentSession(
        { ...fixture.deps, appDb, sessionRegistry: { register } },
        { incidentId: randomUUID(), ticket, sink: collector.sink },
      ),
    ).rejects.toThrow('session state unavailable');
    expect(collector.closed()).toEqual([1008, 'internal error']);
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  test('a future-skew token is rejected after monotonic durable revocation', async () => {
    const incidentId = await fixture.freshIncident();
    const issuedAt = Math.floor(Date.now() / 1_000) + 30;
    await setUserNotBefore(fixture.app.db, fixture.userA, issuedAt);
    const collector = fixture.collector();
    const { ticket } = await fixture.mintTicket({
      tenantId: fixture.tenantA,
      sub: 'future-skew-revoked',
      tokenIssuedAt: issuedAt * 1_000,
    });

    await expect(
      openIncidentSession(fixture.deps, { incidentId, ticket, sink: collector.sink }),
    ).resolves.toBeNull();
    expect(collector.closed()).toEqual([1008, 'signed out']);
  });
});
