import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import {
  attachFounderToFounding,
  identityProviders,
  jobs,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  type DbHandle,
} from '@sre/db';
import { FOUNDING_JOB_STREAM, makeFoundingQueue, type FoundingQueue } from '@sre/queue';
import { makeApp } from '../../app';
import type { AuthDeps } from '../../auth';
import { makeFoundingJobHandler, startFoundingWorker } from '../founding-worker';
import { foundingRoutes } from '../foundings';
import type { Notifier } from '@sre/notifications';

const marker = randomUUID();
const issuer = `https://founding-api-${marker}.invalid`;
const providerId = randomUUID();
const providerIds = new Set([providerId]);
const audience = 'sre-api';
const kid = 'founding-api';
const founderSubject = 'founder';
const strangerSubject = 'stranger';
const secret = Buffer.alloc(32, 7).toString('base64');
let admin: DbHandle;
let appDb: DbHandle;
let redis: Redis;
let privateKey: CryptoKey;
let api: ReturnType<typeof makeApp>;
let queue: ReturnType<typeof makeFoundingQueue>;
let founderToken: string;
let strangerToken: string;
let auth: AuthDeps;
const tenantIds = new Set<string>();
const foundingIds = new Set<string>();
const rateAllow = vi.fn(async () => true);
const notify = vi.fn<Notifier['notify']>(async () => undefined);

async function insertScenarioProvider(label: string): Promise<string> {
  const id = randomUUID();
  providerIds.add(id);
  await admin.db.insert(identityProviders).values({
    id,
    displayName: `Founding ${label} ${marker}`,
    issuer: `https://founding-${label}-${marker}.invalid`,
    jwksUri: `https://founding-${label}-${marker}.invalid/jwks`,
    audience,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  return id;
}

function sign(subject: string): Promise<string> {
  return new SignJWT({
    sub: subject,
    email: `${subject}-${marker}@example.test`,
    email_verified: true,
  })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function foundingRequest(body: Record<string, unknown>) {
  return api.request('/foundings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  appDb = makeDb(process.env.APP_DATABASE_URL!);
  redis = new Redis(process.env.VALKEY_URL!, { db: 11, maxRetriesPerRequest: null });
  const pair = await generateKeyPair('RS256', { extractable: true });
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  const keys = createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet);
  await admin.db.insert(identityProviders).values({
    id: providerId,
    displayName: `Founding API ${marker}`,
    issuer,
    jwksUri: `${issuer}/jwks`,
    audience,
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  auth = {
    verifiers: {
      byIssuer: async (value) =>
        value === issuer
          ? {
              providerId,
              issuer,
              audience,
              keys,
              emailClaim: 'email',
              subjectClaim: 'sub',
              tenantClaim: null,
              scope: 'tenant',
            }
          : undefined,
      forFounding: async () => undefined,
      invalidate() {},
    },
    db: appDb.db,
    adminDb: admin.db,
    settings: { get: async () => 86_400 },
    revoke: { publish: async () => undefined },
  };
  queue = makeFoundingQueue(admin.db, redis);
  await queue.ensureGroup();
  api = makeApp({
    auth,
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets: makeSecretStore(appDb.db, secret),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
    foundingQueue: queue,
    publicRateLimiter: { allow: rateAllow },
    publicSourceAddress: () => '198.51.100.20',
    registrationMode: async () => 'open',
    notifier: { notify },
  });
  founderToken = await sign(founderSubject);
  strangerToken = await sign(strangerSubject);
}, 30_000);

afterAll(async () => {
  if (!admin) return;
  const foundings = await admin.db
    .select({ tenantId: workspaceFoundings.tenantId })
    .from(workspaceFoundings)
    .where(sql`${workspaceFoundings.slug} like ${`api-${marker}-%`}`);
  for (const founding of foundings) if (founding.tenantId) tenantIds.add(founding.tenantId);
  if (foundingIds.size > 0) {
    await admin.db.delete(jobs).where(inArray(jobs.idempotencyKey, [...foundingIds]));
  }
  if (tenantIds.size > 0) {
    const ids = [...tenantIds];
    await admin.db.delete(memberships).where(inArray(memberships.tenantId, ids));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(inArray(tenantIdentityBindings.tenantId, ids));
  }
  await admin.db
    .delete(workspaceFoundings)
    .where(sql`${workspaceFoundings.slug} like ${`api-${marker}-%`}`);
  if (tenantIds.size > 0) await admin.db.delete(tenants).where(inArray(tenants.id, [...tenantIds]));
  await admin.db.delete(users).where(eq(users.issuer, issuer));
  await admin.db.delete(identityProviders).where(inArray(identityProviders.id, [...providerIds]));
  await redis.del(FOUNDING_JOB_STREAM, 'sre:founding:dead');
  redis.disconnect();
  await Promise.all([admin.close(), appDb.close()]);
});

describe('workspace founding API', () => {
  test('maps a founder-authenticated manual domain check without exposing it to another user', async () => {
    const created = await foundingRequest({
      path: 'own_directory',
      slug: `api-${marker}-manual-domain`,
      requestedName: 'Manual domain check',
    });
    const foundingId = ((await created.json()) as { founding: { id: string } }).founding.id;
    foundingIds.add(foundingId);
    await api.request('/me', { headers: { authorization: `Bearer ${founderToken}` } });
    const [founder] = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, founderSubject)))
      .limit(1);
    await attachFounderToFounding(admin.db, {
      foundingId,
      providerId,
      founderUserId: founder!.id,
    });
    const checkDomain = vi.fn(async (_id: string, userId: string) =>
      userId === founder!.id ? ({ status: 'pending' as const } as const) : null,
    );
    const domainAllow = vi.fn(async () => true);
    const route = foundingRoutes({
      auth,
      db: admin.db,
      registrationMode: async () => 'approval_required',
      limiter: { allow: domainAllow },
      sourceAddress: () => '198.51.100.20',
      oidc: {
        discover: async () => {
          throw new Error('not used');
        },
        checkDomain,
      },
    });
    const manualApi = new Hono().route('/', route);

    const ownerResponse = await manualApi.request(`/foundings/${foundingId}/check-domain`, {
      method: 'POST',
      headers: { authorization: `Bearer ${founderToken}` },
    });
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toEqual({ status: 'pending' });
    expect(domainAllow).toHaveBeenCalledWith(
      'founding-domain-check',
      `${founder!.id}:${foundingId}:198.51.100.20`,
      6,
      60_000,
    );
    expect(
      (
        await manualApi.request(`/foundings/${foundingId}/check-domain`, {
          method: 'POST',
          headers: { authorization: `Bearer ${strangerToken}` },
        })
      ).status,
    ).toBe(404);
    domainAllow.mockResolvedValueOnce(false);
    expect(
      (
        await manualApi.request(`/foundings/${foundingId}/check-domain`, {
          method: 'POST',
          headers: { authorization: `Bearer ${founderToken}` },
        })
      ).status,
    ).toBe(429);
    domainAllow.mockRejectedValueOnce(new Error('rate limiter unavailable'));
    expect(
      (
        await manualApi.request(`/foundings/${foundingId}/check-domain`, {
          method: 'POST',
          headers: { authorization: `Bearer ${founderToken}` },
        })
      ).status,
    ).toBe(503);
    await admin.db
      .update(workspaceFoundings)
      .set({ status: 'expired' })
      .where(eq(workspaceFoundings.id, foundingId));
  });

  test('creates a founding, hides it from another user, provisions, and projects verified /me', async () => {
    const slug = `api-${marker}-workspace`;
    const created = await foundingRequest({
      path: 'own_directory',
      slug,
      requestedName: 'API workspace',
      declaredDomain: 'example.test',
    });
    expect(created.status).toBe(201);
    const { founding } = (await created.json()) as { founding: { id: string } };
    foundingIds.add(founding.id);

    const unaffiliated = await api.request('/me', {
      headers: { authorization: `Bearer ${founderToken}` },
    });
    expect(await unaffiliated.json()).toMatchObject({ state: 'unaffiliated', tenant: null });
    const founder = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, founderSubject)))
      .limit(1);
    await attachFounderToFounding(admin.db, {
      foundingId: founding.id,
      providerId,
      founderUserId: founder[0]!.id,
    });
    expect(
      await (
        await api.request('/me', {
          headers: { authorization: `Bearer ${founderToken}` },
        })
      ).json(),
    ).toMatchObject({
      state: 'founding',
      founding: { id: founding.id, status: 'founder_authenticated' },
      tenant: null,
    });

    const stranger = await api.request(`/foundings/${founding.id}`, {
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(stranger.status).toBe(404);
    expect(
      (
        await api.request(`/foundings/${founding.id}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${strangerToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ slug, requestedName: 'Not yours' }),
        })
      ).status,
    ).toBe(404);
    const owner = await api.request(`/foundings/${founding.id}`, {
      headers: { authorization: `Bearer ${founderToken}` },
    });
    expect(owner.status).toBe(200);

    const submitted = await api.request(`/foundings/${founding.id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${founderToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug, requestedName: 'API workspace' }),
    });
    expect(submitted.status).toBe(202);
    expect(notify).toHaveBeenCalledWith(
      { userId: founder[0]!.id },
      'founding.approved',
      { workspaceName: 'API workspace' },
      { eventKey: `founding:${founding.id}:approved` },
    );
    const durableJobs = await admin.db
      .select({ id: jobs.id, type: jobs.type, idempotencyKey: jobs.idempotencyKey })
      .from(jobs)
      .where(eq(jobs.stream, FOUNDING_JOB_STREAM));
    expect(durableJobs).toContainEqual({
      id: expect.any(String),
      type: 'founding.provision',
      idempotencyKey: founding.id,
    });

    expect(
      await queue.process('founding-api-test', makeFoundingJobHandler(admin.db), { idleMs: 0 }),
    ).toBe(1);
    const activeFounding = await admin.db
      .select({ tenantId: workspaceFoundings.tenantId, status: workspaceFoundings.status })
      .from(workspaceFoundings)
      .where(eq(workspaceFoundings.id, founding.id));
    expect(activeFounding[0]).toMatchObject({ status: 'active', tenantId: expect.any(String) });
    tenantIds.add(activeFounding[0]!.tenantId!);

    const me = await api.request('/me', {
      headers: { authorization: `Bearer ${founderToken}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({
      state: 'active',
      tenant: { slug, role: 'owner' },
      founding: null,
      workspaces: [{ slug, role: 'owner' }],
    });
  });

  test('rejects oversized and invalid public founding input before persistence', async () => {
    rateAllow.mockClear();
    const oversized = await api.request('/foundings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'own_directory',
        slug: `api-${marker}-oversized`,
        requestedName: 'x'.repeat(5 * 1024),
      }),
    });
    expect(oversized.status).toBe(413);
    expect(rateAllow).not.toHaveBeenCalled();

    expect(
      (
        await foundingRequest({
          path: 'own_directory',
          slug: `api-${marker}-invalid-domain`,
          requestedName: 'Invalid domain',
          declaredDomain: `${'a'.repeat(64)}.example.test`,
        })
      ).status,
    ).toBe(400);
  });

  test('returns a conflict for a duplicate founding address', async () => {
    const slug = `api-${marker}-duplicate`;
    const body = { path: 'own_directory', slug, requestedName: 'First' };
    const first = await foundingRequest(body);
    expect(first.status).toBe(201);
    foundingIds.add(((await first.json()) as { founding: { id: string } }).founding.id);
    expect((await foundingRequest(body)).status).toBe(409);
  });

  test('marks a tenant-address collision failed and provisions after a founder retry', async () => {
    const collidingSlug = `api-${marker}-taken`;
    const existingTenantId = randomUUID();
    tenantIds.add(existingTenantId);
    await admin.db.insert(tenants).values({
      id: existingTenantId,
      name: 'Existing tenant',
      slug: collidingSlug,
    });
    const created = await foundingRequest({
      path: 'own_directory',
      slug: collidingSlug,
      requestedName: 'Collision workspace',
    });
    const { founding } = (await created.json()) as { founding: { id: string } };
    foundingIds.add(founding.id);
    const founder = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, founderSubject)))
      .limit(1);
    await attachFounderToFounding(admin.db, {
      foundingId: founding.id,
      providerId: await insertScenarioProvider('collision'),
      founderUserId: founder[0]!.id,
    });
    const headers = {
      authorization: `Bearer ${founderToken}`,
      'content-type': 'application/json',
    };
    expect(
      (
        await api.request(`/foundings/${founding.id}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({ slug: collidingSlug, requestedName: 'Collision workspace' }),
        })
      ).status,
    ).toBe(202);
    expect(
      await queue.process('founding-collision-test', makeFoundingJobHandler(admin.db), {
        idleMs: 0,
      }),
    ).toBe(1);
    expect(
      (
        await admin.db
          .select({ status: workspaceFoundings.status, reason: workspaceFoundings.failureReason })
          .from(workspaceFoundings)
          .where(eq(workspaceFoundings.id, founding.id))
      )[0],
    ).toEqual({ status: 'failed', reason: 'address taken' });

    const reservedRetry = await api.request(`/foundings/${founding.id}/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: 'settings' }),
    });
    expect(reservedRetry.status).toBe(400);
    expect(
      (
        await admin.db
          .select({ slug: workspaceFoundings.slug, status: workspaceFoundings.status })
          .from(workspaceFoundings)
          .where(eq(workspaceFoundings.id, founding.id))
      )[0],
    ).toEqual({ slug: collidingSlug, status: 'failed' });

    const changedSlug = `api-${marker}-available`;
    const busyInsert = vi
      .spyOn(queue, 'insertProvisionTx')
      .mockResolvedValueOnce({ jobId: `job:${founding.id}`, created: false });
    const busyRetry = await api.request(`/foundings/${founding.id}/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ slug: changedSlug }),
    });
    expect(busyRetry.status).toBe(409);
    expect(await busyRetry.json()).toEqual({
      error: 'the previous provisioning attempt is still finishing',
      code: 'founding_job_busy',
    });
    busyInsert.mockRestore();
    expect(
      (
        await api.request(`/foundings/${founding.id}/retry`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ slug: changedSlug }),
        })
      ).status,
    ).toBe(202);
    expect(
      await queue.process('founding-retry-test', makeFoundingJobHandler(admin.db), { idleMs: 0 }),
    ).toBe(1);
    const retried = (
      await admin.db
        .select({ status: workspaceFoundings.status, tenantId: workspaceFoundings.tenantId })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, founding.id))
    )[0]!;
    expect(retried).toMatchObject({ status: 'active', tenantId: expect.any(String) });
    tenantIds.add(retried.tenantId!);
  });

  test('worker expires abandoned foundings and recreates stale provisioning commands', async () => {
    const expired = await foundingRequest({
      path: 'own_directory',
      slug: `api-${marker}-worker-expired`,
      requestedName: 'Expired workspace',
    });
    const expiredId = ((await expired.json()) as { founding: { id: string } }).founding.id;
    foundingIds.add(expiredId);
    await admin.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceFoundings.id, expiredId));

    const created = await foundingRequest({
      path: 'own_directory',
      slug: `api-${marker}-stale`,
      requestedName: 'Stale workspace',
    });
    const { founding } = (await created.json()) as { founding: { id: string } };
    foundingIds.add(founding.id);
    const founder = await admin.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.issuer, issuer), eq(users.subject, founderSubject)))
      .limit(1);
    await attachFounderToFounding(admin.db, {
      foundingId: founding.id,
      providerId: await insertScenarioProvider('stale'),
      founderUserId: founder[0]!.id,
    });
    await api.request(`/foundings/${founding.id}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${founderToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ slug: `api-${marker}-stale`, requestedName: 'Stale workspace' }),
    });
    await admin.db.delete(jobs).where(eq(jobs.idempotencyKey, founding.id));
    await admin.db
      .update(workspaceFoundings)
      .set({ status: 'provisioning', updatedAt: new Date(Date.now() - 600_000) })
      .where(eq(workspaceFoundings.id, founding.id));
    const publishJob = vi.fn(async () => undefined);
    const workerQueue = {
      ensureGroup: vi.fn(async () => undefined),
      process: vi.fn(async () => 0),
      reconcile: vi.fn(async () => 0),
      dispatchDue: vi.fn(async () => 0),
      insertProvisionTx: queue.insertProvisionTx.bind(queue),
      publishJob,
    } as unknown as FoundingQueue;
    const worker = await startFoundingWorker(workerQueue, makeFoundingJobHandler(admin.db), {
      db: admin.db,
      pollMs: 5,
      reconcileMs: 1,
    });
    await expect.poll(() => publishJob.mock.calls.length).toBeGreaterThanOrEqual(1);
    await worker.stop();

    expect(
      await admin.db
        .select({ status: workspaceFoundings.status })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, expiredId)),
    ).toEqual([{ status: 'expired' }]);
    expect(
      await admin.db
        .select({ idempotencyKey: jobs.idempotencyKey })
        .from(jobs)
        .where(eq(jobs.idempotencyKey, founding.id)),
    ).toEqual([{ idempotencyKey: founding.id }]);
  });
});
