import { createHash, randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import {
  applyBackchannelLogout,
  backchannelLogoutReceipts,
  browserSessions,
  createBrowserSession,
  getBrowserSession,
  identityProviders,
  makeDb,
  revokeBrowserSession,
  users,
  type BackchannelLogoutTarget,
  type DbHandle,
} from '../index';

const providerId = randomUUID();
const otherProviderId = randomUUID();
const issuer = `https://db-logout-${randomUUID()}.provider.invalid/`;
const otherIssuer = `https://db-logout-other-${randomUUID()}.provider.invalid/`;
const clientId = 'db-logout-client';
let db: DbHandle;

function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function apply(jti: string, target: BackchannelLogoutTarget, selectedProvider = providerId) {
  return applyBackchannelLogout(db.db, {
    providerId: selectedProvider,
    clientId,
    jtiHash: hash(jti),
    expiresAt: new Date(Date.now() + 300_000),
    target,
  });
}

async function session(oidcSubject: string, oidcSessionId: string, selectedClient = clientId) {
  const [user] = await db.db
    .insert(users)
    .values({ issuer, subject: randomUUID(), email: `${randomUUID()}@example.test` })
    .returning();
  const created = await createBrowserSession(db.db, {
    providerId,
    clientId: selectedClient,
    userId: user!.id,
    foundingId: null,
    oidcSubject,
    oidcSessionId,
    bindingClaimValue: null,
    authenticatedAt: new Date(Date.now() - 60_000),
    idleSeconds: 3_600,
    absoluteSeconds: 86_400,
  });
  return { user: user!, session: created.session, credential: created.credential };
}

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(identityProviders).values([
    {
      id: providerId,
      displayName: 'Database logout provider',
      issuer,
      jwksUri: `${issuer}jwks`,
      browserClientId: clientId,
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
    {
      id: otherProviderId,
      displayName: 'Other database logout provider',
      issuer: otherIssuer,
      jwksUri: `${otherIssuer}jwks`,
      browserClientId: clientId,
      kind: 'oidc',
      scope: 'tenant',
      status: 'active',
    },
  ]);
});

beforeEach(async () => {
  await db.db
    .delete(backchannelLogoutReceipts)
    .where(inArray(backchannelLogoutReceipts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, issuer));
});

afterAll(async () => {
  if (!db) return;
  await db.db
    .delete(backchannelLogoutReceipts)
    .where(inArray(backchannelLogoutReceipts.providerId, [providerId, otherProviderId]));
  await db.db.delete(users).where(eq(users.issuer, issuer));
  await db.db
    .delete(identityProviders)
    .where(inArray(identityProviders.id, [providerId, otherProviderId]));
  await db.close();
});

test('subject logout consumes its receipt and revokes exact sessions and users atomically', async () => {
  const first = await session('raw-subject', 'sid-1');
  const second = await session('raw-subject', 'sid-2');
  const otherSubject = await session('other-subject', 'sid-3');
  const staleClient = await session('raw-subject', 'sid-4', 'retired-client');

  const result = await apply('subject-token', { kind: 'subject', oidcSubject: 'raw-subject' });

  expect(result.status).toBe('applied');
  if (result.status !== 'applied') throw new Error('expected applied result');
  expect(result.userIds.sort()).toEqual([first.user.id, second.user.id].sort());
  expect(result.sessions.map(({ id }) => id).sort()).toEqual(
    [first.session.id, second.session.id].sort(),
  );
  const sessions = await db.db
    .select({ id: browserSessions.id, revokedAt: browserSessions.revokedAt })
    .from(browserSessions)
    .where(
      inArray(browserSessions.id, [
        first.session.id,
        second.session.id,
        otherSubject.session.id,
        staleClient.session.id,
      ]),
    );
  expect(
    sessions
      .filter(({ revokedAt }) => revokedAt)
      .map(({ id }) => id)
      .sort(),
  ).toEqual([first.session.id, second.session.id].sort());
  const identities = await db.db
    .select({ id: users.id, notBefore: users.notBefore })
    .from(users)
    .where(inArray(users.id, [first.user.id, second.user.id, otherSubject.user.id]));
  expect(
    identities
      .filter(({ notBefore }) => notBefore)
      .map(({ id }) => id)
      .sort(),
  ).toEqual([first.user.id, second.user.id].sort());
  expect(
    await db.db
      .select({ jtiHash: backchannelLogoutReceipts.jtiHash })
      .from(backchannelLogoutReceipts),
  ).toContainEqual({ jtiHash: hash('subject-token') });
});

test('sid logout is session-scoped and never advances the user-wide cutoff', async () => {
  const matching = await session('first', 'shared-sid');
  const other = await session('second', 'other-sid');

  const result = await apply('sid-token', { kind: 'session', oidcSessionId: 'shared-sid' });

  expect(result).toEqual({
    status: 'applied',
    userIds: [],
    sessions: [{ id: matching.session.id, userId: matching.user.id }],
  });
  expect(
    await db.db
      .select({ id: users.id, notBefore: users.notBefore })
      .from(users)
      .where(inArray(users.id, [matching.user.id, other.user.id])),
  ).toEqual(
    expect.arrayContaining([
      { id: matching.user.id, notBefore: null },
      { id: other.user.id, notBefore: null },
    ]),
  );
});

test('subject logout maps revoked historical sessions and denies older credentials', async () => {
  const historical = await session('historical-subject', 'ended-session');
  await revokeBrowserSession(db.db, historical.credential);
  const olderCredential = await createBrowserSession(db.db, {
    providerId,
    clientId: 'other-client',
    userId: historical.user.id,
    foundingId: null,
    oidcSubject: 'other-subject',
    oidcSessionId: 'other-session',
    bindingClaimValue: null,
    authenticatedAt: new Date(Date.now() - 60_000),
    idleSeconds: 3_600,
    absoluteSeconds: 86_400,
  });

  const result = await apply('historical-token', {
    kind: 'subject',
    oidcSubject: 'historical-subject',
  });

  expect(result).toMatchObject({ status: 'applied', userIds: [historical.user.id], sessions: [] });
  expect(await getBrowserSession(db.db, olderCredential.credential, 3_600)).toBeNull();
  expect(
    await db.db
      .select({ revokedAt: browserSessions.revokedAt })
      .from(browserSessions)
      .where(eq(browserSessions.id, olderCredential.session.id)),
  ).toEqual([{ revokedAt: null }]);
});

test('sid plus subject revokes only the exact upstream identity session', async () => {
  const exact = await session('raw-subject', 'shared-sid');
  const wrongSubject = await session('other-subject', 'shared-sid');
  const wrongSid = await session('raw-subject', 'other-sid');

  const result = await apply('sid-sub-token', {
    kind: 'session',
    oidcSessionId: 'shared-sid',
    oidcSubject: 'raw-subject',
  });

  expect(result).toEqual({
    status: 'applied',
    userIds: [],
    sessions: [{ id: exact.session.id, userId: exact.user.id }],
  });
  expect(
    await db.db
      .select({ id: browserSessions.id, revokedAt: browserSessions.revokedAt })
      .from(browserSessions)
      .where(inArray(browserSessions.id, [wrongSubject.session.id, wrongSid.session.id])),
  ).toEqual(
    expect.arrayContaining([
      { id: wrongSubject.session.id, revokedAt: null },
      { id: wrongSid.session.id, revokedAt: null },
    ]),
  );
});

test('an active receipt rejects replay without mutating sessions created afterward', async () => {
  await expect(
    apply('replayed-token', { kind: 'subject', oidcSubject: 'raw-subject' }),
  ).resolves.toMatchObject({ status: 'applied' });
  const later = await session('raw-subject', 'later-sid');

  await expect(
    apply('replayed-token', { kind: 'subject', oidcSubject: 'raw-subject' }),
  ).resolves.toEqual({ status: 'replay', userIds: [], sessions: [] });
  expect(
    await db.db
      .select({ revokedAt: browserSessions.revokedAt })
      .from(browserSessions)
      .where(eq(browserSessions.id, later.session.id)),
  ).toEqual([{ revokedAt: null }]);
});

test('the same token identifier is independent across providers', async () => {
  await expect(
    apply('shared-token', { kind: 'subject', oidcSubject: 'unknown' }),
  ).resolves.toMatchObject({ status: 'applied' });
  await expect(
    apply('shared-token', { kind: 'subject', oidcSubject: 'unknown' }, otherProviderId),
  ).resolves.toMatchObject({ status: 'applied' });

  expect(
    await db.db
      .select({ providerId: backchannelLogoutReceipts.providerId })
      .from(backchannelLogoutReceipts)
      .where(eq(backchannelLogoutReceipts.jtiHash, hash('shared-token'))),
  ).toEqual(expect.arrayContaining([{ providerId }, { providerId: otherProviderId }]));
});

test('a database failure rolls back both the receipt and revocation so the token can retry', async () => {
  const target = await session('rollback-subject', 'rollback-sid');
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const functionName = `bcl_fail_fn_${suffix}`;
  const triggerName = `bcl_fail_tr_${suffix}`;
  await db.db.execute(
    sql.raw(`
    create function ${functionName}() returns trigger language plpgsql as $$
    begin
      if new.id = '${target.user.id}'::uuid then
        raise exception 'injected back-channel cutoff failure';
      end if;
      return new;
    end
    $$
  `),
  );
  await db.db.execute(
    sql.raw(`
    create trigger ${triggerName}
    before update on users
    for each row execute function ${functionName}()
  `),
  );

  try {
    await expect(
      apply('rollback-token', { kind: 'subject', oidcSubject: 'rollback-subject' }),
    ).rejects.toThrow('Failed query: update "users"');
    expect(
      await db.db
        .select({ id: backchannelLogoutReceipts.id })
        .from(backchannelLogoutReceipts)
        .where(eq(backchannelLogoutReceipts.jtiHash, hash('rollback-token'))),
    ).toEqual([]);
    expect(
      await db.db
        .select({ revokedAt: browserSessions.revokedAt })
        .from(browserSessions)
        .where(eq(browserSessions.id, target.session.id)),
    ).toEqual([{ revokedAt: null }]);
  } finally {
    await db.db.execute(sql.raw(`drop trigger ${triggerName} on users`));
    await db.db.execute(sql.raw(`drop function ${functionName}()`));
  }

  await expect(
    apply('rollback-token', { kind: 'subject', oidcSubject: 'rollback-subject' }),
  ).resolves.toMatchObject({ status: 'applied' });
  expect(
    await db.db
      .select({ id: backchannelLogoutReceipts.id })
      .from(backchannelLogoutReceipts)
      .where(eq(backchannelLogoutReceipts.jtiHash, hash('rollback-token'))),
  ).toHaveLength(1);
});

test('opportunistic retention removes only a bounded batch of expired receipts', async () => {
  await db.db.insert(backchannelLogoutReceipts).values(
    Array.from({ length: 105 }, (_, index) => ({
      providerId,
      jtiHash: hash(`expired-${index}`),
      expiresAt: new Date(Date.now() - 60_000),
    })),
  );

  await apply('fresh-token', { kind: 'subject', oidcSubject: 'unknown' });

  expect(
    await db.db
      .select({ id: backchannelLogoutReceipts.id })
      .from(backchannelLogoutReceipts)
      .where(eq(backchannelLogoutReceipts.providerId, providerId)),
  ).toHaveLength(6);
});
