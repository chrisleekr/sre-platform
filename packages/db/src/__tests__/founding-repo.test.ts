import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  attachFounderToFounding,
  createWorkspaceFounding,
  expireWorkspaceFoundings,
  failFounding,
  findOpenFoundingForUser,
  listWorkspacesForUser,
  getFoundingForUser,
  makeDb,
  markFoundingProvisioning,
  memberships,
  platformSecrets,
  provisionFounding,
  retryWorkspaceFounding,
  submitWorkspaceFounding,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  identityProviders,
  type DbHandle,
  type FoundingJobInsert,
  type Tx,
} from '../index';

const DATABASE_URL = process.env.DATABASE_URL!;
const marker = randomUUID();
const founderId = randomUUID();
const strangerId = randomUUID();
const createdTenantIds = new Set<string>();
const providerIds = new Set<string>();
const platformSecretNames = new Set<string>();
let db: DbHandle;

test('workspace sign-in availability requires a usable bound provider', async () => {
  const tenantId = randomUUID();
  const providerId = randomUUID();
  createdTenantIds.add(tenantId);
  providerIds.add(providerId);
  await db.db
    .insert(tenants)
    .values({ id: tenantId, name: 'Unconfigured workspace', slug: `availability-${marker}` });
  await db.db.insert(memberships).values({ userId: founderId, tenantId, role: 'member' });
  const available = async () =>
    (await listWorkspacesForUser(db.db, founderId)).find((workspace) => workspace.id === tenantId)
      ?.signInAvailable;
  expect(await available()).toBe(false);
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Company',
    issuer: `https://availability-${marker}.invalid`,
    jwksUri: `https://availability-${marker}.invalid/jwks`,
    audience: 'api',
    kind: 'oidc',
    scope: 'installation',
    status: 'active',
    browserClientId: 'browser',
    authorizationEndpoint: `https://availability-${marker}.invalid/authorize`,
  });
  expect(await available()).toBe(false);
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId });
  expect(await available()).toBe(false);
  await db.db
    .update(identityProviders)
    .set({ tenantClaim: 'organization' })
    .where(eq(identityProviders.id, providerId));
  expect(await available()).toBe(false);
  await db.db
    .update(tenantIdentityBindings)
    .set({ claimValue: 'company' })
    .where(eq(tenantIdentityBindings.providerId, providerId));
  expect(await available()).toBe(true);
  await db.db
    .update(identityProviders)
    .set({ browserClientId: null })
    .where(eq(identityProviders.id, providerId));
  expect(await available()).toBe(false);
  await db.db
    .update(identityProviders)
    .set({ browserClientId: 'browser', status: 'disabled' })
    .where(eq(identityProviders.id, providerId));
  expect(await available()).toBe(false);
  await db.db
    .update(identityProviders)
    .set({ status: 'active' })
    .where(eq(identityProviders.id, providerId));
  await db.db.update(tenants).set({ requireDirectory: true }).where(eq(tenants.id, tenantId));
  expect(await available()).toBe(false);
});

async function insertJob(_tx: Tx, foundingId: string): Promise<FoundingJobInsert> {
  return { jobId: `job:${foundingId}`, created: true };
}

beforeAll(async () => {
  db = makeDb(DATABASE_URL);
  await db.db.insert(users).values([
    { id: founderId, issuer: `https://founding-${marker}.invalid`, subject: 'founder' },
    { id: strangerId, issuer: `https://founding-${marker}.invalid`, subject: 'stranger' },
  ]);
});

afterAll(async () => {
  if (!db) return;
  const foundingRows = await db.db
    .select({ tenantId: workspaceFoundings.tenantId })
    .from(workspaceFoundings)
    .where(sql`${workspaceFoundings.slug} like ${`founding-${marker}-%`}`);
  for (const row of foundingRows) if (row.tenantId) createdTenantIds.add(row.tenantId);
  if (createdTenantIds.size > 0) {
    const ids = [...createdTenantIds];
    await db.db.delete(memberships).where(inArray(memberships.tenantId, ids));
    await db.db.delete(tenantIdentityBindings).where(inArray(tenantIdentityBindings.tenantId, ids));
  }
  await db.db
    .delete(workspaceFoundings)
    .where(sql`${workspaceFoundings.slug} like ${`founding-${marker}-%`}`);
  if (createdTenantIds.size > 0) {
    await db.db.delete(tenants).where(inArray(tenants.id, [...createdTenantIds]));
  }
  await db.db.delete(users).where(inArray(users.id, [founderId, strangerId]));
  if (providerIds.size > 0) {
    await db.db.delete(identityProviders).where(inArray(identityProviders.id, [...providerIds]));
  }
  if (platformSecretNames.size > 0) {
    await db.db
      .delete(platformSecrets)
      .where(inArray(platformSecrets.name, [...platformSecretNames]));
  }
  await db.close();
});

async function authenticatedFounding(suffix: string) {
  const providerId = randomUUID();
  providerIds.add(providerId);
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: `Founding provider ${suffix} ${marker}`,
    issuer: `https://founding-${suffix}-${marker}.invalid`,
    jwksUri: `https://founding-${suffix}-${marker}.invalid/jwks`,
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'tenant',
    status: 'provisional',
  });
  const founding = await createWorkspaceFounding(db.db, {
    path: 'own_directory',
    slug: `founding-${marker}-${suffix}`,
    requestedName: `Workspace ${suffix}`,
    declaredDomain: `${suffix}.example.test`,
  });
  await attachFounderToFounding(db.db, {
    foundingId: founding.id,
    providerId,
    founderUserId: founderId,
  });
  return { ...founding, providerId };
}

describe('workspace founding repository', () => {
  test('creates a one-hour awaiting-founder record and enforces unique addresses', async () => {
    const slug = `founding-${marker}-create`;
    const before = Date.now();
    const founding = await createWorkspaceFounding(db.db, {
      path: 'own_directory',
      slug,
      requestedName: 'Create test',
      declaredDomain: 'create.example.test',
    });
    expect(founding).toMatchObject({ slug, status: 'awaiting_founder' });
    expect(founding.expiresAt!.getTime()).toBeGreaterThanOrEqual(before + 3_590_000);
    expect(founding.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now() + 3_610_000);
    await expect(
      createWorkspaceFounding(db.db, {
        path: 'own_directory',
        slug,
        requestedName: 'Duplicate',
      }),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  test('expires abandoned foundings and releases their workspace address', async () => {
    const slug = `founding-${marker}-expired`;
    const expired = await createWorkspaceFounding(db.db, {
      path: 'own_directory',
      slug,
      requestedName: 'Expired founding',
    });
    await db.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceFoundings.id, expired.id));

    expect(await expireWorkspaceFoundings(db.db)).toBeGreaterThanOrEqual(1);
    expect(
      await db.db
        .select({ status: workspaceFoundings.status })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, expired.id)),
    ).toEqual([{ status: 'expired' }]);
    await expect(
      createWorkspaceFounding(db.db, {
        path: 'own_directory',
        slug,
        requestedName: 'Replacement founding',
      }),
    ).resolves.toMatchObject({ slug, status: 'awaiting_founder' });
  });

  test('removes draft editing and OIDC secrets when an abandoned setup expires', async () => {
    const founding = await authenticatedFounding('expired-secrets');
    const names = [`setup-editor:${founding.id}`, `oidc-client:${founding.providerId}`];
    names.forEach((name) => platformSecretNames.add(name));
    await db.db.insert(platformSecrets).values(
      names.map((name) => ({
        name,
        ciphertext: Buffer.from('encrypted'),
        nonce: Buffer.alloc(12),
        authTag: Buffer.alloc(16),
        keyVersion: 1,
      })),
    );
    await db.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceFoundings.id, founding.id));

    expect(await expireWorkspaceFoundings(db.db, founding.slug)).toBe(1);
    expect(
      await db.db
        .select({ name: platformSecrets.name })
        .from(platformSecrets)
        .where(inArray(platformSecrets.name, names)),
    ).toEqual([]);
  });

  test('finds an open founding only for its authenticated founder', async () => {
    const founding = await authenticatedFounding('ownership');
    expect(await getFoundingForUser(db.db, founding.id, founderId)).toMatchObject({
      id: founding.id,
      status: 'founder_authenticated',
    });
    expect(await getFoundingForUser(db.db, founding.id, strangerId)).toBeNull();
    expect(await findOpenFoundingForUser(db.db, founderId)).toMatchObject({ id: founding.id });
  });

  test('keeps the latest rejected founding visible to its founder', async () => {
    const founding = await authenticatedFounding('rejected-visible');
    await db.db
      .update(workspaceFoundings)
      .set({
        status: 'rejected',
        failureReason: 'Administrator declined the request.',
        updatedAt: new Date(Date.now() + 60_000),
      })
      .where(eq(workspaceFoundings.id, founding.id));

    expect(await findOpenFoundingForUser(db.db, founderId)).toMatchObject({
      id: founding.id,
      status: 'rejected',
      failureReason: 'Administrator declined the request.',
    });
  });

  test('submits approval-required work without a job and open registration with one durable job', async () => {
    const pending = await authenticatedFounding('pending');
    const pendingResult = await submitWorkspaceFounding(db.db, {
      foundingId: pending.id,
      founderUserId: founderId,
      requestedName: 'Pending workspace',
      slug: pending.slug,
      registrationMode: 'approval_required',
      insertJobTx: insertJob,
    });
    expect(pendingResult).toMatchObject({ status: 'pending', jobId: null });

    const approved = await authenticatedFounding('approved');
    const approvedResult = await submitWorkspaceFounding(db.db, {
      foundingId: approved.id,
      founderUserId: founderId,
      requestedName: 'Approved workspace',
      slug: approved.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    expect(approvedResult).toMatchObject({
      status: 'approved',
      jobId: `job:${approved.id}`,
    });
  });

  test('never submits or starts provisioning through an expired provisional provider', async () => {
    const expiredBeforeSubmit = await authenticatedFounding('expired-before-submit');
    await db.db
      .update(workspaceFoundings)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(workspaceFoundings.id, expiredBeforeSubmit.id));
    await expect(
      submitWorkspaceFounding(db.db, {
        foundingId: expiredBeforeSubmit.id,
        founderUserId: founderId,
        requestedName: expiredBeforeSubmit.requestedName,
        slug: expiredBeforeSubmit.slug,
        registrationMode: 'open',
        insertJobTx: insertJob,
      }),
    ).rejects.toThrow(/ready|expired/i);

    const expiredBeforeWorker = await authenticatedFounding('expired-before-worker');
    await submitWorkspaceFounding(db.db, {
      foundingId: expiredBeforeWorker.id,
      founderUserId: founderId,
      requestedName: expiredBeforeWorker.requestedName,
      slug: expiredBeforeWorker.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    await db.db
      .update(identityProviders)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(identityProviders.id, expiredBeforeWorker.providerId));
    await expect(markFoundingProvisioning(db.db, expiredBeforeWorker.id)).rejects.toThrow(
      /expired/i,
    );
  });

  test('provisions tenant, binding, owner membership, and active founding once', async () => {
    const founding = await authenticatedFounding('provision');
    await submitWorkspaceFounding(db.db, {
      foundingId: founding.id,
      founderUserId: founderId,
      requestedName: 'Provisioned workspace',
      slug: founding.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    expect(await markFoundingProvisioning(db.db, founding.id)).toBe('provisioning');
    const first = await provisionFounding(db.db, founding.id);
    createdTenantIds.add(first.tenantId);
    expect(first.status).toBe('active');
    expect(await provisionFounding(db.db, founding.id)).toEqual({
      status: 'already_active',
      tenantId: first.tenantId,
    });
    expect(
      await db.db
        .select({ role: memberships.role, status: memberships.status })
        .from(memberships)
        .where(and(eq(memberships.userId, founderId), eq(memberships.tenantId, first.tenantId))),
    ).toEqual([{ role: 'owner', status: 'active' }]);
    expect(
      await db.db
        .select({ status: identityProviders.status })
        .from(identityProviders)
        .where(eq(identityProviders.id, founding.providerId)),
    ).toEqual([{ status: 'pending_verification' }]);
  });

  test('rolls back every provisioned row when the binding insert fails', async () => {
    const founding = await authenticatedFounding('rollback');
    const existingTenantId = randomUUID();
    createdTenantIds.add(existingTenantId);
    await db.db.insert(tenants).values({
      id: existingTenantId,
      name: 'Existing binding',
      slug: `founding-${marker}-existing-binding`,
    });
    await db.db
      .insert(tenantIdentityBindings)
      .values({ tenantId: existingTenantId, providerId: founding.providerId, claimValue: null });

    await submitWorkspaceFounding(db.db, {
      foundingId: founding.id,
      founderUserId: founderId,
      requestedName: 'Must roll back',
      slug: founding.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    await markFoundingProvisioning(db.db, founding.id);
    await expect(provisionFounding(db.db, founding.id)).rejects.toBeDefined();
    expect(await db.db.select().from(tenants).where(eq(tenants.slug, founding.slug))).toHaveLength(
      0,
    );
    expect(
      (
        await db.db.select().from(workspaceFoundings).where(eq(workspaceFoundings.id, founding.id))
      )[0]?.status,
    ).toBe('provisioning');
  });

  test('records a recoverable failure and retries after an address change', async () => {
    const founding = await authenticatedFounding('retry');
    await submitWorkspaceFounding(db.db, {
      foundingId: founding.id,
      founderUserId: founderId,
      requestedName: founding.requestedName,
      slug: founding.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    await markFoundingProvisioning(db.db, founding.id);
    await failFounding(db.db, founding.id, 'address taken');
    const retried = await retryWorkspaceFounding(db.db, {
      foundingId: founding.id,
      founderUserId: founderId,
      slug: `founding-${marker}-retry-changed`,
      insertJobTx: insertJob,
    });
    expect(retried).toMatchObject({
      status: 'approved',
      failureReason: null,
      jobId: `job:${founding.id}`,
    });
  });

  test('leaves a failed founding retryable while its previous command is still finishing', async () => {
    const founding = await authenticatedFounding('busy-retry');
    await submitWorkspaceFounding(db.db, {
      foundingId: founding.id,
      founderUserId: founderId,
      requestedName: founding.requestedName,
      slug: founding.slug,
      registrationMode: 'open',
      insertJobTx: insertJob,
    });
    await markFoundingProvisioning(db.db, founding.id);
    await failFounding(db.db, founding.id, 'address taken');

    await expect(
      retryWorkspaceFounding(db.db, {
        foundingId: founding.id,
        founderUserId: founderId,
        slug: `founding-${marker}-busy-retry-changed`,
        insertJobTx: async () => ({ jobId: 'still-processing', created: false }),
      }),
    ).rejects.toMatchObject({ code: 'founding_job_busy' });
    expect(await getFoundingForUser(db.db, founding.id, founderId)).toMatchObject({
      status: 'failed',
      failureReason: 'address taken',
    });
    await expect(
      retryWorkspaceFounding(db.db, {
        foundingId: founding.id,
        founderUserId: founderId,
        slug: `founding-${marker}-busy-retry-changed`,
        insertJobTx: insertJob,
      }),
    ).resolves.toMatchObject({ status: 'approved' });
  });
});
