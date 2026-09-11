import { seedMembership } from '../test-support';
// surface_identities auto-attribution cache. A resolved Slack author id is cached per tenant so a
// later reply reuses the mapping without another users.info call. The table is under RLS and unique on
// (tenant_id, surface, surface_user_id); author_user_id is a PLAIN FK to users.id (users carries no
// tenant_id), so Postgres checks only that the user exists and tenant scoping is RLS, not RI.
// These tests prove the invariants that block merge: idempotent persist (C5), cross-tenant isolation
// (C6, tenant B cannot read tenant A's cached row), and that a cached mapping does not out-live the
// membership behind it (— the FK cannot enforce that, so the repo must). Harness mirrors
// composite-fk.test.ts and secret-store.test.ts (admin + app handles, withTenant per tenant).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  persistSurfaceIdentity,
  lookupSurfaceIdentity,
  resolveUserByEmail,
  type DbHandle,
} from '../index';
import { tenants, users, memberships, surfaceIdentities } from '../schema';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const ISSUER = 'https://test.idp.local/';
const SLACK_USER_A = 'U_A_CACHE';
const SUBJECT_A = 'sub|si-a';
// Ex-member fixture: its own user + Slack id so revoking its membership cannot disturb SLACK_USER_A.
const SLACK_USER_EX = 'U_EX_MEMBER';
const SUBJECT_EX = 'sub|si-ex';
const EMAIL_EX = 'si-ex@x.io';
// Dual-tenant fixture: a member of BOTH tenants, so the memberships join cannot be what refuses a
// cross-tenant read and RLS is isolated as the sole cause. Separate from SLACK_USER_A, whose rows the
// order-dependent persist/lookup tests above share.
const SLACK_USER_DUAL = 'U_DUAL';
const SUBJECT_DUAL = 'sub|si-dual';
const EMAIL_DUAL = 'si-dual@x.io';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
let memberUserIdA: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  // A real member of tenantA. The FK only requires the user to exist, so a same-tenant member is what the
  // CALLER must supply for the cached mapping to be correct; the DB would not catch a foreign one.
  memberUserIdA = await seedMembership(
    admin.db,
    { issuer: ISSUER, subject: SUBJECT_A, email: 'si-a@x.io' },
    tenantA,
  );
}, 30_000);

afterAll(async () => {
  if (admin) {
    const both = sql`tenant_id in (${tenantA}, ${tenantB})`;
    await admin.db.delete(surfaceIdentities).where(both);
    await admin.db.delete(memberships).where(both);
    await admin.db
      .delete(users)
      .where(sql`issuer = ${ISSUER} and subject in (${SUBJECT_A}, ${SUBJECT_EX}, ${SUBJECT_DUAL})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('surface_identities repo + RLS', () => {
  test('C5: persistSurfaceIdentity is idempotent on (tenant, surface, surface_user_id) — exactly one row', async () => {
    await persistSurfaceIdentity(app.db, tenantA, {
      surface: 'slack',
      surfaceUserId: SLACK_USER_A,
      authorUserId: memberUserIdA,
      source: 'auto',
    });
    // Redelivery of the same event re-runs persist; the unique index folds it onto the first row.
    await persistSurfaceIdentity(app.db, tenantA, {
      surface: 'slack',
      surfaceUserId: SLACK_USER_A,
      authorUserId: memberUserIdA,
      source: 'auto',
    });
    const rows = await admin.db
      .select()
      .from(surfaceIdentities)
      .where(
        sql`tenant_id = ${tenantA} and surface = 'slack' and surface_user_id = ${SLACK_USER_A}`,
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('auto'); // provenance is stamped, not just row-count
  });

  test('C5: persistSurfaceIdentity defaults source to auto when omitted', async () => {
    // Exercises the `source ?? 'auto'` default branch — the resolver always passes 'auto', so this is
    // the only coverage of the default itself.
    await persistSurfaceIdentity(app.db, tenantA, {
      surface: 'slack',
      surfaceUserId: 'U_DEFAULT_SRC',
      authorUserId: memberUserIdA,
    });
    const rows = await admin.db
      .select()
      .from(surfaceIdentities)
      .where(
        sql`tenant_id = ${tenantA} and surface = 'slack' and surface_user_id = 'U_DEFAULT_SRC'`,
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('auto');
  });

  test('C4/C5: lookupSurfaceIdentity returns the cached author_user_id under the owning tenant', async () => {
    const hit = await lookupSurfaceIdentity(app.db, tenantA, 'slack', SLACK_USER_A);
    expect(hit).toBe(memberUserIdA);
  });

  // The dual-tenant fixture is what makes this test able to FAIL. With a tenant-A-only member, the
  // memberships join refuses the tenant-B read on its own, so the assertion would hold even with
  // RLS off and the test would read as coverage it does not provide. A member of BOTH tenants satisfies
  // the join under either one, leaving RLS on surface_identities as the only thing that can refuse.
  test('C6: tenant B cannot read tenant A cached identity (RLS isolation)', async () => {
    const dualId = await seedMembership(
      admin.db,
      { issuer: ISSUER, subject: SUBJECT_DUAL, email: EMAIL_DUAL },
      tenantA,
    );
    await seedMembership(
      admin.db,
      { issuer: ISSUER, subject: SUBJECT_DUAL, email: EMAIL_DUAL },
      tenantB,
    );
    await persistSurfaceIdentity(app.db, tenantA, {
      surface: 'slack',
      surfaceUserId: SLACK_USER_DUAL,
      authorUserId: dualId,
      source: 'auto',
    });
    expect(await lookupSurfaceIdentity(app.db, tenantA, 'slack', SLACK_USER_DUAL)).toBe(dualId);
    expect(await lookupSurfaceIdentity(app.db, tenantB, 'slack', SLACK_USER_DUAL)).toBeNull();
    // The tenant-A-only fixture stays covered too: RLS and the join both refuse here.
    expect(await lookupSurfaceIdentity(app.db, tenantB, 'slack', SLACK_USER_A)).toBeNull();
  });

  // the cache must not out-live the membership that justified it. A cached mapping is an
  // attribution-of-record input, not a display label: slack-inbound.ts:162-163 returns the cache hit and
  // never reaches resolveUserByEmail (:166), so the stale id flows to applyApprovalDecision and gets
  // stamped on the durable `decided:` reply. That breaches approval-decision.ts:45-55, which requires
  // authorUserId to be ALREADY PROVEN a member of tenantId, or null. Nothing self-corrects it either:
  // author_user_id is a plain FK to users.id with no cascade and no FK to memberships, so revoking the
  // membership leaves the row intact, and persistSurfaceIdentity's onConflictDoNothing means the first
  // resolution wins permanently. The two handles here mirror production exactly: the cache reads the app
  // (RLS) connection, the fresh path the admin (control-plane) one.
  test('C6: lookupSurfaceIdentity must not attribute an ex-member after their membership is revoked', async () => {
    const exUserId = await seedMembership(
      admin.db,
      { issuer: ISSUER, subject: SUBJECT_EX, email: EMAIL_EX },
      tenantA,
    );
    await persistSurfaceIdentity(app.db, tenantA, {
      surface: 'slack',
      surfaceUserId: SLACK_USER_EX,
      authorUserId: exUserId,
      source: 'auto',
    });
    // While the membership stands, both paths agree on the same person. Holds before AND after the fix.
    expect(await lookupSurfaceIdentity(app.db, tenantA, 'slack', SLACK_USER_EX)).toBe(exUserId);
    expect(await resolveUserByEmail(admin.db, tenantA, EMAIL_EX)).toBe(exUserId);

    // U leaves tenant A. Only the membership goes; the users row survives (users is non-tenant).
    await admin.db.delete(memberships).where(sql`tenant_id = ${tenantA} and user_id = ${exUserId}`);
    const survivingUser = await admin.db
      .select()
      .from(users)
      .where(sql`id = ${exUserId}`);
    expect(survivingUser).toHaveLength(1);

    // No cascade reaches surface_identities, so the stale mapping is still on disk. Asserted so the RED
    // below is unambiguously the lookup's missing membership check, not a row that quietly disappeared.
    const cachedRows = await admin.db
      .select()
      .from(surfaceIdentities)
      .where(
        sql`tenant_id = ${tenantA} and surface = 'slack' and surface_user_id = ${SLACK_USER_EX}`,
      );
    expect(cachedRows).toHaveLength(1);
    expect(cachedRows[0]!.authorUserId).toBe(exUserId);

    // The fresh path already refuses a non-member (innerJoin memberships, identity-repo.ts:77-79).
    expect(await resolveUserByEmail(admin.db, tenantA, EMAIL_EX)).toBeNull();

    // RED: the cached path must agree. Today it still returns the ex-member — same input, two paths,
    // two answers — so an ex-member's next tap is credited to them on the approval record.
    expect(await lookupSurfaceIdentity(app.db, tenantA, 'slack', SLACK_USER_EX)).toBeNull();

    // U does not just leave A, they join B. This is the case that pins the load-bearing
    // memberships.tenantId filter: memberships is not RLS-covered (migrate.ts:69), so without that
    // filter the join matches U's tenant-B membership on user_id alone and credits a tenant-B person
    // on tenant A's durable reply. Revocation alone cannot catch this — a moved user HAS a membership.
    await seedMembership(
      admin.db,
      { issuer: ISSUER, subject: SUBJECT_EX, email: EMAIL_EX },
      tenantB,
    );
    expect(await lookupSurfaceIdentity(app.db, tenantA, 'slack', SLACK_USER_EX)).toBeNull();
  });
});
