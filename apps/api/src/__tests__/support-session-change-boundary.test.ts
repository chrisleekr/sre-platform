// An impersonated support session is a read of someone else's workspace. It may look at membership
// and settings while diagnosing, but it must not change who belongs to the workspace or what the
// workspace is. Each refusal asserts the stored row, because a refusal that still wrote is not one.
//
// The impersonating operator deliberately holds an owner membership here. Without it the repository
// layer refuses the member mutations for an unrelated reason (it resolves the actor's own membership
// and finds none), and every case below would pass with no guard in place at all.
import { seedMembership } from '@sre/db/test-support';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JSONWebKeySet } from 'jose';
import {
  makeDb,
  makeSecretStore,
  impersonationSessions,
  memberships,
  platformOperators,
  incidents,
  incidentTags,
  tenantIdentityBindings,
  tenantInvitations,
  tenants,
  users,
  type DbHandle,
  type MembershipRole,
} from '@sre/db';
import type { Notifier } from '@sre/notifications';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const ISSUER = 'https://support-boundary.auth0.local/';
const AUDIENCE = 'sre-api';
const KID = 'test-key';
const KEY = Buffer.alloc(32, 9).toString('base64');
const WORKSPACE_NAME = 'Boundary Workspace';

/** The one refusal every impersonated change shares, whatever the operator's own rights are. */
const REFUSED = 'A support session cannot change this workspace.';

let admin: DbHandle;
let app: DbHandle;
let api: ReturnType<typeof makeApp>;
let privateKey: CryptoKey;
let orgA: string;
let tenantA: string;
let operatorUserId: string;
let targetUserId: string;
let incidentId: string;
const notify = vi.fn<Notifier['notify']>(async () => undefined);

function sign(org: string): Promise<string> {
  return new SignJWT({ sub: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

async function headers(): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await sign(orgA)}`, 'content-type': 'application/json' };
}

/** Mints the support session `x-impersonation-session` resolves against, over this workspace. */
async function impersonated(): Promise<Record<string, string>> {
  const [session] = await admin.db
    .insert(impersonationSessions)
    .values({
      actorUserId: operatorUserId,
      tenantId: tenantA,
      reason: 'Diagnose a customer-reported sign-in failure',
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning({ id: impersonationSessions.id });
  expect(session).toBeDefined();
  return { ...(await headers()), 'x-impersonation-session': session!.id };
}

async function setRole(role: MembershipRole): Promise<void> {
  await admin.db
    .update(memberships)
    .set({ role })
    .where(and(eq(memberships.tenantId, tenantA), eq(memberships.userId, operatorUserId)));
}

/** Creates one pending invitation directly, so seeding never depends on the route under test. */
async function seedInvitation(): Promise<{ id: string; expiresAt: Date }> {
  const [row] = await admin.db
    .insert(tenantInvitations)
    .values({
      tenantId: tenantA,
      email: `invitee-${randomUUID().slice(0, 8)}@example.test`,
      role: 'member',
      invitedByUserId: operatorUserId,
      status: 'pending',
      expiresAt: sql`clock_timestamp() + interval '7 days'`,
    })
    .returning({ id: tenantInvitations.id, expiresAt: tenantInvitations.expiresAt });
  expect(row).toBeDefined();
  return row!;
}

function invitationRows() {
  return admin.db
    .select({
      id: tenantInvitations.id,
      status: tenantInvitations.status,
      expiresAt: tenantInvitations.expiresAt,
    })
    .from(tenantInvitations)
    .where(eq(tenantInvitations.tenantId, tenantA));
}

function workspaceName(): Promise<string | undefined> {
  return admin.db
    .select({ name: tenants.name })
    .from(tenants)
    .where(eq(tenants.id, tenantA))
    .then((rows) => rows[0]?.name);
}

function targetMembership() {
  return admin.db
    .select({ role: memberships.role, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tenantA), eq(memberships.userId, targetUserId)));
}

/** Opens one incident directly, so seeding never depends on a route this suite is refusing. */
async function seedIncident(): Promise<string> {
  const [row] = await admin.db
    .insert(incidents)
    .values({
      tenantId: tenantA,
      fingerprint: `support-boundary-${randomUUID()}`,
      alertSource: 'slack',
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'gathering',
      title: 'Checkout latency',
    })
    .returning({ id: incidents.id });
  expect(row).toBeDefined();
  return row!.id;
}

function incidentRow() {
  return admin.db
    .select({ status: incidents.status, title: incidents.title })
    .from(incidents)
    .where(eq(incidents.id, incidentId));
}

function tagRows() {
  return admin.db
    .select({ incidentId: incidentTags.incidentId })
    .from(incidentTags)
    .where(eq(incidentTags.tenantId, tenantA));
}

// The signal routes mount only when the app is built with a route, an evaluation queue and a
// runtime fingerprint. Every case below is refused or exempted before a handler runs, so none of
// these collaborators is ever dereferenced; they exist so the router is mounted at all.
const unusedSignalRoute = {
  appDb: undefined,
  redis: undefined,
  queue: undefined,
} as unknown as Parameters<typeof makeApp>[0]['signalRoute'];

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  const secrets = makeSecretStore(app.db, KEY);

  const kp = await generateKeyPair('RS256', { extractable: true });
  privateKey = kp.privateKey;
  const jwk = await exportJWK(kp.publicKey);
  jwk.kid = KID;
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);

  orgA = `org_${randomUUID().slice(0, 8)}`;
  tenantA = randomUUID();
  await admin.db.insert(tenants).values([{ id: tenantA, name: WORKSPACE_NAME }]);
  operatorUserId = await seedMembership(
    admin.db,
    { issuer: ISSUER, subject: orgA },
    tenantA,
    'owner',
  );
  targetUserId = await seedMembership(
    admin.db,
    { issuer: ISSUER, subject: `${orgA}-colleague` },
    tenantA,
    'member',
  );
  // Impersonation resolves only for a platform operator on an installation-scoped provider, which
  // is what makeTestAuth installs.
  await admin.db.insert(platformOperators).values({ userId: operatorUserId }).onConflictDoNothing();
  incidentId = await seedIncident();
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: app.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      bindings: [{ tenantId: tenantA, subject: orgA }],
    }),
    readinessDb: app.db,
    appDb: app.db,
    secrets,
    notifier: { notify },
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    signalRoute: unusedSignalRoute,
    signalEvaluationQueue: {
      insertJobTx: async () => {
        throw new Error('signal queue must not be reached');
      },
      publishJob: async () => {
        throw new Error('signal queue must not be reached');
      },
    } as unknown as Parameters<typeof makeApp>[0]['signalEvaluationQueue'],
    signalRuntimeFingerprint: async () => 'unused',
  });
}, 30_000);

afterEach(async () => {
  await admin.db.delete(impersonationSessions).where(eq(impersonationSessions.tenantId, tenantA));
  await admin.db.delete(incidentTags).where(eq(incidentTags.tenantId, tenantA));
  await admin.db.update(incidents).set({ status: 'open' }).where(eq(incidents.id, incidentId));
  await admin.db.delete(tenantInvitations).where(eq(tenantInvitations.tenantId, tenantA));
  await admin.db.update(tenants).set({ name: WORKSPACE_NAME }).where(eq(tenants.id, tenantA));
  await admin.db
    .update(memberships)
    .set({ role: 'member', status: 'active' })
    .where(and(eq(memberships.tenantId, tenantA), eq(memberships.userId, targetUserId)));
  await setRole('owner');
  notify.mockClear();
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(platformOperators).where(eq(platformOperators.userId, operatorUserId));
    await admin.db.delete(incidentTags).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(incidents).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(memberships).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(tenantIdentityBindings).where(sql`tenant_id = ${tenantA}`);
    await admin.db.delete(users).where(sql`issuer = ${ISSUER}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantA}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('workspace membership under an impersonated support session', () => {
  test('inviting a member stores no invitation and sends no mail', async () => {
    const response = await api.request('/tenant/invitations', {
      method: 'POST',
      headers: await impersonated(),
      body: JSON.stringify({ email: 'newcomer@example.test', role: 'member' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
    expect(await invitationRows()).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  test('resending an invitation neither extends it nor sends mail', async () => {
    const seeded = await seedInvitation();

    const response = await api.request(`/tenant/invitations/${seeded.id}/resend`, {
      method: 'POST',
      headers: await impersonated(),
    });

    expect(response.status).toBe(403);
    // The route's only write is the new expiry, so an unchanged one proves it never ran.
    const [row] = await invitationRows();
    expect(row?.expiresAt).toEqual(seeded.expiresAt);
    expect(notify).not.toHaveBeenCalled();
  });

  test('revoking an invitation leaves it pending', async () => {
    const seeded = await seedInvitation();

    const response = await api.request(`/tenant/invitations/${seeded.id}`, {
      method: 'DELETE',
      headers: await impersonated(),
    });

    expect(response.status).toBe(403);
    expect(await invitationRows()).toEqual([
      { id: seeded.id, status: 'pending', expiresAt: seeded.expiresAt },
    ]);
  });

  test('removing a member leaves the membership active', async () => {
    const response = await api.request(`/tenant/members/${targetUserId}`, {
      method: 'DELETE',
      headers: await impersonated(),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
    expect(await targetMembership()).toEqual([{ role: 'member', status: 'active' }]);
  });

  test('promoting a member leaves the role unchanged', async () => {
    const response = await api.request(`/tenant/members/${targetUserId}/role`, {
      method: 'PUT',
      headers: await impersonated(),
      body: JSON.stringify({ role: 'admin' }),
    });

    expect(response.status).toBe(403);
    expect(await targetMembership()).toEqual([{ role: 'member', status: 'active' }]);
  });

  test('the member list is still readable', async () => {
    const response = await api.request('/tenant/members', { headers: await impersonated() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { members: Array<{ userId: string }> };
    expect(body.members.map((member) => member.userId)).toContain(targetUserId);
  });
});

describe('workspace identity under an impersonated support session', () => {
  test('renaming the workspace leaves the name unchanged', async () => {
    const response = await api.request('/tenant/settings', {
      method: 'PUT',
      headers: await impersonated(),
      body: JSON.stringify({ name: 'Renamed By Support' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
    expect(await workspaceName()).toBe(WORKSPACE_NAME);
  });

  test('re-checking a domain stays reachable', async () => {
    // Re-checking reads verification state from DNS rather than changing the workspace, and a
    // support session is usually why anyone looks. The app is built without a domain checker, so
    // 503 is this route answering for itself: any refusal from the guard would be a 403 instead.
    const response = await api.request(`/tenant/domains/${randomUUID()}/check`, {
      method: 'POST',
      headers: await impersonated(),
    });

    expect(response.status).toBe(503);
  });
});

describe('a direct workspace session', () => {
  test('an administrator still invites a member', async () => {
    await setRole('admin');

    const response = await api.request('/tenant/invitations', {
      method: 'POST',
      headers: await headers(),
      body: JSON.stringify({ email: 'newcomer@example.test', role: 'member' }),
    });

    expect(response.status).toBe(201);
    expect((await invitationRows()).map((row) => row.status)).toEqual(['pending']);
  });

  test('an administrator still renames the workspace', async () => {
    await setRole('admin');

    const response = await api.request('/tenant/settings', {
      method: 'PUT',
      headers: await headers(),
      body: JSON.stringify({ name: 'Renamed By An Administrator' }),
    });

    expect(response.status).toBe(200);
    expect(await workspaceName()).toBe('Renamed By An Administrator');
  });
});

describe('incident work under an impersonated support session', () => {
  test('resolving an incident leaves its status untouched', async () => {
    const response = await api.request(`/incidents/${incidentId}/lifecycle`, {
      method: 'POST',
      headers: await impersonated(),
      body: JSON.stringify({ action: 'resolve' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
    expect(await incidentRow()).toEqual([{ status: 'open', title: 'Checkout latency' }]);
  });

  test('tagging an incident stores no tag', async () => {
    const response = await api.request(`/incidents/${incidentId}/tags`, {
      method: 'POST',
      headers: await impersonated(),
      body: JSON.stringify({ tag: 'support-was-here' }),
    });

    expect(response.status).toBe(403);
    expect(await tagRows()).toHaveLength(0);
  });

  test('promoting a signal is refused before the signal is read', async () => {
    // An unknown signal id answers 404, so a 403 here can only come from a check that runs first.
    const response = await api.request(`/signals/${randomUUID()}/promote`, {
      method: 'POST',
      headers: await impersonated(),
      body: JSON.stringify({ reason: 'support promoted this' }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSED });
  });

  test('the incident stays readable', async () => {
    const response = await api.request(`/incidents/${incidentId}`, {
      headers: await impersonated(),
    });

    expect(response.status).toBe(200);
  });
});

describe('platform-operator work inside a support session', () => {
  // Impersonation is the only way an operator reaches a tenant context, so the routes that already
  // require platform-operator rights must stay reachable or they become unreachable entirely.
  // Neither case asserts success: each asserts the guard did not answer, which is what it owns.
  test('correcting an ingested signal reaches its own handler', async () => {
    const response = await api.request(`/incidents/${incidentId}/signals/${randomUUID()}/correct`, {
      method: 'POST',
      headers: await impersonated(),
      body: JSON.stringify({ reason: 'wrong' }),
    });

    expect(response.status).not.toBe(403);
  });

  test('setting the signal policy reaches its own handler', async () => {
    const response = await api.request('/signals/policy', {
      method: 'PUT',
      headers: await impersonated(),
      body: JSON.stringify({ retentionDays: 30 }),
    });

    expect(await response.json()).not.toEqual({ error: REFUSED });
  });
});
