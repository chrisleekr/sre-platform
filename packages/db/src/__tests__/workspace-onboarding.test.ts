import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  connectorConfigs,
  dismissWorkspaceWelcome,
  markWorkspaceWelcomeShown,
  getWorkspaceAddressAvailability,
  getWorkspaceWelcome,
  identityProviderDomains,
  identityProviders,
  makeDb,
  memberships,
  submitWorkspaceFounding,
  surfaceConfigs,
  tenantIdentityBindings,
  tenants,
  users,
  workspaceFoundings,
  type DbHandle,
} from '../index';

const marker = randomUUID();
const userId = randomUUID();
const secondUserId = randomUUID();
const tenantId = randomUUID();
const providerId = randomUUID();
const foundingId = randomUUID();
const tenantSlug = `tenant-${marker}`;
const reservedSlug = `reserved-${marker}`;
let db: DbHandle;

beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(users).values([
    { id: userId, issuer: `https://identity-${marker}.invalid`, subject: 'owner' },
    { id: secondUserId, issuer: `https://identity-${marker}.invalid`, subject: 'member' },
  ]);
  await db.db.insert(tenants).values({ id: tenantId, name: 'Acme', slug: tenantSlug });
  await db.db.insert(memberships).values([
    { userId, tenantId, role: 'owner' },
    { userId: secondUserId, tenantId, role: 'member' },
  ]);
  await db.db.insert(identityProviders).values({
    id: providerId,
    displayName: 'Acme directory',
    issuer: `https://directory-${marker}.invalid`,
    jwksUri: `https://directory-${marker}.invalid/jwks`,
    authorizationEndpoint: `https://directory-${marker}.invalid/authorize`,
    browserClientId: 'browser-client',
    audience: 'sre-api',
    kind: 'oidc',
    scope: 'tenant',
    status: 'active',
  });
  await db.db.insert(tenantIdentityBindings).values({ tenantId, providerId, claimValue: null });
  await db.db.insert(identityProviderDomains).values({
    providerId,
    domain: `acme-${marker}.test`,
    status: 'verified',
  });
  await db.db.insert(connectorConfigs).values({
    tenantId,
    name: 'Metrics',
    type: 'prometheus',
    settings: {},
  });
  await db.db.insert(surfaceConfigs).values({
    tenantId,
    surface: 'slack',
    teamId: `team-${marker}`,
  });
  await db.db.insert(workspaceFoundings).values([
    {
      id: foundingId,
      path: 'own_directory',
      requestedName: 'Reserved',
      slug: reservedSlug,
      status: 'founder_authenticated',
      providerId,
      founderUserId: userId,
      expiresAt: new Date(Date.now() + 60_000),
    },
  ]);
});

afterAll(async () => {
  if (!db) return;
  await db.db.delete(surfaceConfigs).where(eq(surfaceConfigs.tenantId, tenantId));
  await db.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
  await db.db.delete(workspaceFoundings).where(eq(workspaceFoundings.id, foundingId));
  await db.db
    .delete(identityProviderDomains)
    .where(eq(identityProviderDomains.providerId, providerId));
  await db.db.delete(tenantIdentityBindings).where(eq(tenantIdentityBindings.tenantId, tenantId));
  await db.db.delete(memberships).where(eq(memberships.tenantId, tenantId));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.db.delete(identityProviders).where(eq(identityProviders.id, providerId));
  await db.db.delete(users).where(inArray(users.id, [userId, secondUserId]));
  await db.close();
});

describe('workspace onboarding repository', () => {
  test('checks active workspaces and every nonterminal founding reservation', async () => {
    await expect(getWorkspaceAddressAvailability(db.db, tenantSlug)).resolves.toEqual({
      available: false,
      code: 'workspace_exists',
    });
    await expect(getWorkspaceAddressAvailability(db.db, reservedSlug)).resolves.toEqual({
      available: false,
      code: 'workspace_reserved',
    });
    await expect(getWorkspaceAddressAvailability(db.db, `free-${marker}`)).resolves.toEqual({
      available: true,
    });

    await db.db
      .update(workspaceFoundings)
      .set({ status: 'expired' })
      .where(eq(workspaceFoundings.id, foundingId));
    await expect(getWorkspaceAddressAvailability(db.db, reservedSlug)).resolves.toEqual({
      available: true,
    });
    await db.db
      .update(workspaceFoundings)
      .set({ status: 'founder_authenticated' })
      .where(eq(workspaceFoundings.id, foundingId));
  });

  test('derives checklist evidence and persists dismissal per user and workspace', async () => {
    await expect(getWorkspaceWelcome(db.db, { tenantId, userId })).resolves.toEqual({
      workspaceCreated: true,
      domainVerified: true,
      observabilityConnected: true,
      slackConnected: true,
      shown: false,
      dismissed: false,
    });
    await expect(markWorkspaceWelcomeShown(db.db, { tenantId, userId })).resolves.toBe(true);
    await expect(getWorkspaceWelcome(db.db, { tenantId, userId })).resolves.toMatchObject({
      shown: true,
      dismissed: false,
    });
    await dismissWorkspaceWelcome(db.db, { tenantId, userId });
    await expect(getWorkspaceWelcome(db.db, { tenantId, userId })).resolves.toMatchObject({
      dismissed: true,
    });
    await expect(
      getWorkspaceWelcome(db.db, { tenantId, userId: secondUserId }),
    ).resolves.toMatchObject({ shown: false, dismissed: false });
  });

  test('persists the configured terms version when a founder submits', async () => {
    const base = {
      foundingId,
      founderUserId: userId,
      requestedName: 'Reserved',
      slug: reservedSlug,
      registrationMode: 'approval_required' as const,
      requiredTermsVersion: '2026-09',
      insertJobTx: async () => ({ jobId: 'unused', created: true }),
    };
    await expect(submitWorkspaceFounding(db.db, base)).rejects.toMatchObject({
      code: 'terms_required',
    });
    await expect(
      submitWorkspaceFounding(db.db, { ...base, termsAcceptedVersion: 'wrong-version' }),
    ).rejects.toMatchObject({ code: 'terms_required' });
    expect(
      await db.db
        .select({
          status: workspaceFoundings.status,
          terms: workspaceFoundings.termsAcceptedVersion,
        })
        .from(workspaceFoundings)
        .where(eq(workspaceFoundings.id, foundingId)),
    ).toEqual([{ status: 'founder_authenticated', terms: null }]);

    const result = await submitWorkspaceFounding(db.db, {
      ...base,
      termsAcceptedVersion: '2026-09',
    });
    expect(result.termsAcceptedVersion).toBe('2026-09');
  });
});
