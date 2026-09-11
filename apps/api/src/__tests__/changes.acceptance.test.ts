import { seedMembership } from '@sre/db/test-support';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import {
  connectorConfigs,
  githubEvents,
  gitlabEvents,
  makeDb,
  makeSecretStore,
  memberships,
  tenantIdentityBindings,
  tenants,
  users,
  type DbHandle,
} from '@sre/db';
import { makeApp } from '../app';
import { makeTestAuth } from './auth-test-support';

const ADMIN_URL = process.env.DATABASE_URL!;
const APP_URL = process.env.APP_DATABASE_URL!;
const ISSUER = 'https://changes.test.local/';
const AUDIENCE = 'sre-api';
const KID = 'changes-key';
const SECRET_KEY = Buffer.alloc(32, 5).toString('base64');

let admin: DbHandle;
let appDb: DbHandle;
let api: ReturnType<typeof makeApp>;
let tenantA: string;
let tenantB: string;
let subjectA: string;
let subjectB: string;
let tokenA: string;
let githubPrimaryId: string;
let githubSecondaryId: string;
let gitlabId: string;
let seededAt: number;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  appDb = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  subjectA = `changes-a-${randomUUID()}`;
  subjectB = `changes-b-${randomUUID()}`;
  githubPrimaryId = randomUUID();
  githubSecondaryId = randomUUID();
  gitlabId = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: `changes-a-${tenantA}` },
    { id: tenantB, name: `changes-b-${tenantB}` },
  ]);
  await seedMembership(admin.db, { issuer: ISSUER, subject: subjectA }, tenantA);
  await seedMembership(admin.db, { issuer: ISSUER, subject: subjectB }, tenantB);

  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  Object.assign(jwk, { kid: KID, alg: 'RS256', use: 'sig' });
  tokenA = await new SignJWT({ sub: subjectA })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);

  seededAt = Date.now();
  const now = seededAt;
  await admin.db.insert(githubEvents).values([
    {
      tenantId: tenantA,
      connectorId: githubPrimaryId,
      deliveryId: `push-${randomUUID()}`,
      eventType: 'push',
      repositoryFullName: 'acme/checkout',
      actor: 'alice',
      ref: 'refs/heads/main',
      sha: 'a'.repeat(40),
      summary: {
        commitCount: 2,
        headCommit: { message: 'Fix checkout timeout', url: 'https://github.com/acme/checkout' },
        secret: 'must-not-cross-api',
      },
      occurredAt: new Date(now - 1_000),
    },
    {
      tenantId: tenantA,
      connectorId: githubSecondaryId,
      deliveryId: `workflow-${randomUUID()}`,
      eventType: 'workflow_run',
      repositoryFullName: 'acme/checkout',
      actor: 'ci-bot',
      sha: 'b'.repeat(40),
      summary: { name: 'deploy-check', conclusion: 'failure' },
      occurredAt: new Date(now - 2_000),
    },
    {
      tenantId: tenantA,
      connectorId: githubPrimaryId,
      deliveryId: `deployment-${randomUUID()}`,
      eventType: 'deployment_status',
      repositoryFullName: 'acme/checkout',
      summary: { state: 'success' },
      occurredAt: new Date(now - 3_000),
    },
    {
      tenantId: tenantB,
      deliveryId: `other-${randomUUID()}`,
      eventType: 'push',
      repositoryFullName: 'private/other',
      summary: { headCommit: { message: 'tenant B only' } },
      occurredAt: new Date(now),
    },
  ]);
  await admin.db.insert(gitlabEvents).values([
    {
      tenantId: tenantA,
      connectorId: gitlabId,
      deliveryId: `mr-${randomUUID()}`,
      eventType: 'merge_request',
      projectFullPath: 'acme/payments',
      actor: 'bob',
      ref: 'feature/retry',
      sha: 'c'.repeat(40),
      summary: {
        title: 'Retry payment callback',
        state: 'merged',
        url: 'https://gitlab.com/acme/payments/-/merge_requests/1',
      },
      occurredAt: new Date(now - 4_000),
    },
    {
      tenantId: tenantA,
      connectorId: gitlabId,
      deliveryId: `release-${randomUUID()}`,
      eventType: 'release',
      projectFullPath: 'acme/payments',
      actor: 'bob',
      ref: 'v1.2.3',
      sha: 'd'.repeat(40),
      summary: { tag: 'v1.2.3', name: 'Payments 1.2.3' },
      occurredAt: new Date(now - 5_000),
    },
  ]);
  await admin.db.insert(connectorConfigs).values([
    {
      id: githubPrimaryId,
      tenantId: tenantA,
      name: 'Production GitHub',
      type: 'github',
      settings: {},
      enabled: true,
      eventAttemptedAt: new Date(now),
      eventSucceededAt: new Date(now),
      eventCount: 1,
    },
    {
      id: githubSecondaryId,
      tenantId: tenantA,
      name: 'Security GitHub',
      type: 'github',
      settings: {},
      enabled: true,
      eventAttemptedAt: new Date(now),
      eventSucceededAt: new Date(now),
      eventCount: 1,
    },
    {
      id: gitlabId,
      tenantId: tenantA,
      name: 'Engineering GitLab',
      type: 'gitlab',
      settings: {},
      enabled: true,
      eventAttemptedAt: new Date(now),
      eventFailureCategory: 'signature_mismatch',
      eventCount: 2,
    },
  ]);
  api = makeApp({
    auth: await makeTestAuth({
      adminDb: admin.db,
      appDb: appDb.db,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys: createLocalJWKSet({ keys: [jwk] } as JSONWebKeySet),
      bindings: [
        { tenantId: tenantA, subject: subjectA },
        { tenantId: tenantB, subject: subjectB },
      ],
    }),
    readinessDb: appDb.db,
    appDb: appDb.db,
    secrets: makeSecretStore(appDb.db, SECRET_KEY),
    cache: { get: async () => [], set: async () => {} },
    settings: { list: async () => [], set: async () => 1 },
  });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(githubEvents).where(inArray(githubEvents.tenantId, [tenantA, tenantB]));
    await admin.db.delete(gitlabEvents).where(inArray(gitlabEvents.tenantId, [tenantA, tenantB]));
    await admin.db
      .delete(connectorConfigs)
      .where(inArray(connectorConfigs.tenantId, [tenantA, tenantB]));
    await admin.db.delete(memberships).where(inArray(memberships.tenantId, [tenantA, tenantB]));
    await admin.db
      .delete(tenantIdentityBindings)
      .where(inArray(tenantIdentityBindings.tenantId, [tenantA, tenantB]));
    await admin.db.delete(users).where(inArray(users.subject, [subjectA, subjectB]));
    await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await admin.close();
  }
  if (appDb) await appDb.close();
});

describe('change intelligence API', () => {
  test('returns a tenant-scoped, deployment-free, safe timeline with source health', async () => {
    const response = await api.request('/changes?limit=2', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      changes: Array<{ id: string; [key: string]: unknown }>;
      nextCursor: string | null;
      summary: { total: number; failing: number };
      sources: Array<Record<string, unknown>>;
    };
    expect(body.changes).toHaveLength(2);
    expect(body.changes[0]).toMatchObject({
      dataSourceId: githubPrimaryId,
      dataSourceName: 'Production GitHub',
      eventType: 'push',
      title: 'Fix checkout timeout',
    });
    expect(body.changes[0]).not.toHaveProperty('status');
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(body.summary).toMatchObject({ total: 4, failing: 1 });
    expect(body.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: githubPrimaryId,
          name: 'Production GitHub',
          provider: 'github',
          count: 1,
        }),
        expect.objectContaining({
          id: githubSecondaryId,
          name: 'Security GitHub',
          provider: 'github',
          count: 1,
        }),
        expect.objectContaining({
          id: gitlabId,
          name: 'Engineering GitLab',
          provider: 'gitlab',
          failureCategory: 'signature_mismatch',
        }),
      ]),
    );
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('deployment_status');
    expect(serialized).not.toContain('tenant B only');
    expect(serialized).not.toContain('must-not-cross-api');

    const older = await api.request(`/changes?limit=2&cursor=${body.nextCursor}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(older.status).toBe(200);
    const olderChanges = ((await older.json()) as { changes: Array<{ id: string }> }).changes;
    expect(olderChanges).toHaveLength(2);
    const firstPageIds = new Set(body.changes.map(({ id }) => id));
    expect(olderChanges.some(({ id }) => firstPageIds.has(id))).toBe(false);
  });

  test('filters normalized failure outcomes and rejects malformed cursors', async () => {
    const failed = await api.request('/changes?status=failed', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const body = (await failed.json()) as { changes: Array<{ eventType: string }> };
    expect(body.changes).toEqual([expect.objectContaining({ eventType: 'workflow_run' })]);

    const source = await api.request(`/changes?dataSourceId=${githubSecondaryId}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(source.status).toBe(200);
    expect((await source.json()) as object).toMatchObject({
      changes: [
        expect.objectContaining({
          dataSourceId: githubSecondaryId,
          dataSourceName: 'Security GitHub',
          eventType: 'workflow_run',
        }),
      ],
      summary: { total: 1, failing: 1 },
    });

    const malformed = await api.request('/changes?cursor=not-a-cursor', {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(malformed.status).toBe(400);
  });

  test.each([
    ['provider=gitlab', ['merge_request', 'release']],
    ['category=release', ['release']],
    ['repository=acme%2Fpayments', ['merge_request', 'release']],
    ['search=alice', ['push']],
  ])('applies the %s filter', async (query, expectedEventTypes) => {
    const response = await api.request(`/changes?${query}`, {
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      changes: Array<{ eventType: string }>;
      summary: { total: number };
    };
    expect(body.changes.map(({ eventType }) => eventType).sort()).toEqual(
      [...expectedEventTypes].sort(),
    );
    expect(body.summary.total).toBe(expectedEventTypes.length);
  });

  test('applies inclusive time bounds and rejects invalid filter values', async () => {
    const recent = await api.request(
      `/changes?from=${encodeURIComponent(new Date(seededAt - 2_500).toISOString())}`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    expect(recent.status).toBe(200);
    expect(
      ((await recent.json()) as { changes: Array<{ eventType: string }> }).changes.map(
        ({ eventType }) => eventType,
      ),
    ).toEqual(['push', 'workflow_run']);

    const older = await api.request(
      `/changes?to=${encodeURIComponent(new Date(seededAt - 3_500).toISOString())}`,
      { headers: { authorization: `Bearer ${tokenA}` } },
    );
    expect(older.status).toBe(200);
    expect(
      ((await older.json()) as { changes: Array<{ eventType: string }> }).changes.map(
        ({ eventType }) => eventType,
      ),
    ).toEqual(['merge_request', 'release']);

    const invalidQueries = [
      'provider=bitbucket',
      'category=deployment',
      'from=not-a-date',
      `from=${encodeURIComponent(new Date(seededAt).toISOString())}&to=${encodeURIComponent(new Date(seededAt - 1_000).toISOString())}`,
    ];
    for (const query of invalidQueries) {
      const response = await api.request(`/changes?${query}`, {
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid change filters' });
    }
  });
});
