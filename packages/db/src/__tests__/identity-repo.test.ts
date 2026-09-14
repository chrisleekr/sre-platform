import { seedMembership } from '../test-support';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  acceptPlatformAdminInvitation,
  attachMembership,
  getUserEmailById,
  grantPlatformOperator,
  insertAdminInvitation,
  isPlatformOperator,
  makeDb,
  resolveUserByEmail,
  setUserNotBefore,
  upsertIdentity,
  upsertUserForSignIn,
  type DbHandle,
  type Identity,
} from '../index';
import {
  memberships,
  platformAdminInvitations,
  platformOperators,
  tenants,
  users,
} from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const ISSUER = 'https://test.idp.local/';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let listedOperatorUserId: string;
let unlistedOperatorUserId: string;
const subjects: string[] = [];

function ident(subject: string, email?: string): Identity {
  subjects.push(subject);
  return { issuer: ISSUER, subject, email };
}

// Reads the column back rather than trusting a return value, and stays inside one tenant.
function storedRoles(userId: string, tenantId: string): Promise<Array<{ role: string }>> {
  return admin.db
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.tenantId, tenantId)));
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  listedOperatorUserId = await seedMembership(admin.db, ident('sub|operator'), tenantA);
  unlistedOperatorUserId = await seedMembership(admin.db, ident('sub|not-operator'), tenantA);
}, 30_000);

afterAll(async () => {
  if (admin) {
    const subs = subjects;
    await admin.db.delete(memberships).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    if (subs.length)
      await admin.db.delete(users).where(sql`issuer = ${ISSUER} and subject in ${subs}`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('platform operator allowlist', () => {
  const expectPermissionDenied = async (run: Promise<unknown>): Promise<void> => {
    let code: string | undefined;
    try {
      await run;
    } catch (error) {
      const err = error as { code?: string; cause?: { code?: string } };
      code = err.code ?? err.cause?.code;
    }
    expect(code).toBe('42501');
  };

  test('the app role can read the allowlist but cannot mutate it', async () => {
    await admin.db.insert(platformOperators).values({ userId: listedOperatorUserId });
    try {
      const rows = await app.db
        .select({ userId: platformOperators.userId })
        .from(platformOperators)
        .where(eq(platformOperators.userId, listedOperatorUserId));
      expect(rows).toEqual([{ userId: listedOperatorUserId }]);

      await expectPermissionDenied(
        app.db.transaction(async (tx) => {
          await tx.insert(platformOperators).values({ userId: unlistedOperatorUserId });
          tx.rollback();
        }),
      );
      await expectPermissionDenied(
        app.db.transaction(async (tx) => {
          await tx
            .update(platformOperators)
            .set({ userId: unlistedOperatorUserId })
            .where(eq(platformOperators.userId, listedOperatorUserId));
          tx.rollback();
        }),
      );
      await expectPermissionDenied(
        app.db.transaction(async (tx) => {
          await tx
            .delete(platformOperators)
            .where(eq(platformOperators.userId, listedOperatorUserId));
          tx.rollback();
        }),
      );
    } finally {
      await admin.db
        .delete(platformOperators)
        .where(eq(platformOperators.userId, listedOperatorUserId));
    }
  });

  test('lookup returns true only for a listed canonical users.id', async () => {
    await admin.db.insert(platformOperators).values({ userId: listedOperatorUserId });
    try {
      expect(await isPlatformOperator(app.db, listedOperatorUserId)).toBe(true);
      expect(await isPlatformOperator(app.db, unlistedOperatorUserId)).toBe(false);
      expect(await isPlatformOperator(app.db, randomUUID())).toBe(false);
    } finally {
      await admin.db
        .delete(platformOperators)
        .where(eq(platformOperators.userId, listedOperatorUserId));
    }
  });
});

describe('attachMembership', () => {
  test('reports created on the first attach and not created on a re-attach', async () => {
    const id = ident('sub|attach-report');

    const first = await attachMembership(admin.db, id, tenantA);
    expect(first).toEqual({ userId: expect.any(String), created: true });

    const second = await attachMembership(admin.db, id, tenantA);
    expect(second).toEqual({ userId: first.userId, created: false });

    const rows = await admin.db
      .select({ tenantId: memberships.tenantId })
      .from(memberships)
      .where(eq(memberships.userId, first.userId));
    expect(rows).toEqual([{ tenantId: tenantA }]);
  });

  test('stores the supplied role on the first attach', async () => {
    const id = ident('sub|attach-role-first');

    const { userId } = await attachMembership(admin.db, id, tenantA, 'admin');

    expect(await storedRoles(userId, tenantA)).toEqual([{ role: 'admin' }]);
  });

  test('keeps the stored role when a re-attach supplies a different one', async () => {
    const id = ident('sub|attach-role-reattach');
    const first = await attachMembership(admin.db, id, tenantA, 'admin');

    const second = await attachMembership(admin.db, id, tenantA, 'member');

    expect(second).toEqual({ userId: first.userId, created: false });
    expect(await storedRoles(first.userId, tenantA)).toEqual([{ role: 'admin' }]);
  });
});

describe('grantPlatformOperator', () => {
  test('returns true on the first grant and false when the user is already an operator', async () => {
    const userId = await seedMembership(admin.db, ident('sub|grant-report'), tenantA);
    try {
      expect(await grantPlatformOperator(admin.db, userId)).toBe(true);
      expect(await grantPlatformOperator(admin.db, userId)).toBe(false);
      expect(await isPlatformOperator(admin.db, userId)).toBe(true);
    } finally {
      await admin.db.delete(platformOperators).where(eq(platformOperators.userId, userId));
    }
  });
});

describe('bootstrap identity helpers', () => {
  test('upserts one canonical identity without clobbering its stored email', async () => {
    const identity = ident(`sub|bootstrap-${randomUUID()}`, 'bootstrap-admin@example.invalid');

    const first = await upsertIdentity(admin.db, identity);
    const repeat = await upsertIdentity(admin.db, {
      issuer: identity.issuer,
      subject: identity.subject,
    });

    expect(repeat).toBe(first);
    expect(
      await admin.db
        .select({ email: users.email })
        .from(users)
        .where(and(eq(users.issuer, identity.issuer), eq(users.subject, identity.subject))),
    ).toEqual([{ email: identity.email }]);
  });

  test('records and throttles sign-in activity using the database clock', async () => {
    const identity = ident(`sub|sign-in-clock-${randomUUID()}`);
    const [databaseClock] = await admin.sql<Array<{ now: Date | string }>>`
      select clock_timestamp() as now
    `;
    if (!databaseClock) throw new Error('database clock query returned no row');
    const databaseNow = new Date(databaseClock.now);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(databaseNow!.getTime() + 24 * 60 * 60 * 1_000));

    try {
      const { userId } = await upsertUserForSignIn(admin.db, identity);
      const [first] = await admin.db
        .select({ lastSignInAt: users.lastSignInAt })
        .from(users)
        .where(eq(users.id, userId));
      await upsertUserForSignIn(admin.db, identity);
      const [second] = await admin.db
        .select({ lastSignInAt: users.lastSignInAt })
        .from(users)
        .where(eq(users.id, userId));
      const [databaseClockAfter] = await admin.sql<Array<{ now: Date | string }>>`
        select clock_timestamp() as now
      `;
      if (!databaseClockAfter) throw new Error('database clock query returned no row');
      const databaseAfter = new Date(databaseClockAfter.now);

      expect(first?.lastSignInAt).toBeInstanceOf(Date);
      expect(first?.lastSignInAt?.getTime()).toBeLessThanOrEqual(databaseAfter!.getTime());
      expect(second?.lastSignInAt?.getTime()).toBe(first?.lastSignInAt?.getTime());
    } finally {
      vi.useRealTimers();
    }
  });

  test('never moves an existing not-before timestamp backwards', async () => {
    const identity = ident(`sub|monotonic-sign-out-${randomUUID()}`);
    const userId = await upsertIdentity(admin.db, identity);
    const existing = new Date(Date.now() + 120_000);
    await admin.db.update(users).set({ notBefore: existing }).where(eq(users.id, userId));

    const notBefore = await setUserNotBefore(app.db, userId, Math.floor(Date.now() / 1_000) - 60);

    expect(notBefore.getTime()).toBe(existing.getTime());
  });

  test('reports whether an administrator invitation was inserted idempotently', async () => {
    const email = `bootstrap-invitation-${randomUUID()}@example.invalid`;
    try {
      expect(
        await insertAdminInvitation(admin.db, {
          issuer: ISSUER,
          email,
        }),
      ).toBe(true);
      expect(
        await insertAdminInvitation(admin.db, {
          issuer: ISSUER,
          email,
        }),
      ).toBe(false);
      expect(
        await admin.db
          .select({
            issuer: platformAdminInvitations.issuer,
            email: platformAdminInvitations.email,
          })
          .from(platformAdminInvitations)
          .where(eq(platformAdminInvitations.email, email)),
      ).toEqual([{ issuer: ISSUER, email }]);
    } finally {
      await admin.db
        .delete(platformAdminInvitations)
        .where(eq(platformAdminInvitations.email, email));
    }
  });

  test('accepts an administrator invitation only for its exact issuer and email', async () => {
    const email = `bound-invitation-${randomUUID()}@example.invalid`;
    const userId = await upsertIdentity(admin.db, ident(`sub|bound-invitation-${randomUUID()}`));
    await admin.db.insert(platformAdminInvitations).values({ issuer: ISSUER, email });
    try {
      await expect(
        acceptPlatformAdminInvitation(admin.db, {
          issuer: 'https://other-provider.invalid/',
          email,
          userId,
        }),
      ).resolves.toBe(false);
      await expect(
        acceptPlatformAdminInvitation(admin.db, {
          issuer: ISSUER,
          email: `wrong-${email}`,
          userId,
        }),
      ).resolves.toBe(false);
      expect(await isPlatformOperator(admin.db, userId)).toBe(false);
      expect(
        await admin.db
          .select({ acceptedAt: platformAdminInvitations.acceptedAt })
          .from(platformAdminInvitations)
          .where(eq(platformAdminInvitations.email, email)),
      ).toEqual([{ acceptedAt: null }]);
    } finally {
      await admin.db.delete(platformOperators).where(eq(platformOperators.userId, userId));
      await admin.db
        .delete(platformAdminInvitations)
        .where(eq(platformAdminInvitations.email, email));
    }
  });
});

// resolveUserByEmail: joins users↔memberships filtered by tenant_id (control-plane, non-RLS) and
// returns the member's user id ONLY when exactly one tenant member carries that email; otherwise null.
// Backs the Slack-author auto-attribution path — never-wrong-person, so zero and ambiguous both resolve null.
describe('resolveUserByEmail', () => {
  test('C1: returns the user id when exactly one tenant member has that email', async () => {
    const id = ident('sub|email-one', 'one@x.io');
    const userId = await seedMembership(admin.db, id, tenantA);
    expect(await resolveUserByEmail(admin.db, tenantA, 'one@x.io')).toBe(userId);
  });

  test('C2: returns null when no tenant member has that email', async () => {
    expect(await resolveUserByEmail(admin.db, tenantA, 'nobody@x.io')).toBeNull();
  });

  test('C2: returns null when more than one tenant member shares that email (ambiguous, never-wrong-person)', async () => {
    await seedMembership(admin.db, ident('sub|dup-a', 'dup@x.io'), tenantA);
    await seedMembership(admin.db, ident('sub|dup-b', 'dup@x.io'), tenantA);
    expect(await resolveUserByEmail(admin.db, tenantA, 'dup@x.io')).toBeNull();
  });
});

// getUserEmailById: the reverse of resolveUserByEmail — joins users↔memberships filtered by
// tenant_id (control-plane, non-RLS; the tenant scope is the explicit WHERE through memberships) and
// returns the user's email ONLY when that user is a member of the given tenant; otherwise null. Backs
// dashboard→Slack author attribution (👤 <email-local-part> (via dashboard)).
describe('getUserEmailById', () => {
  test('returns the email when the user is a member of that tenant', async () => {
    const id = ident('sub|byid-one', 'byid@x.io');
    const userId = await seedMembership(admin.db, id, tenantA);
    expect(await getUserEmailById(admin.db, tenantA, userId)).toBe('byid@x.io');
  });

  test('returns null when the user belongs to a DIFFERENT tenant (tenant-scoping guard)', async () => {
    const id = ident('sub|byid-other', 'byid-other@x.io');
    const userId = await seedMembership(admin.db, id, tenantB);
    expect(await getUserEmailById(admin.db, tenantA, userId)).toBeNull();
  });

  test('returns null when the member has no stored email', async () => {
    const id = ident('sub|byid-noemail'); // no email on this identity
    const userId = await seedMembership(admin.db, id, tenantA);
    expect(await getUserEmailById(admin.db, tenantA, userId)).toBeNull();
  });
});
