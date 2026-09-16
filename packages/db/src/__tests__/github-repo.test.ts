import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { githubEvents, githubRepositories, serviceRepositories, tenants } from '../schema';
import { makeDb, type DbHandle } from '../client';
import {
  countGitHubRepositories,
  listGitHubRepositories,
  recentGitHubEvents,
  recordGitHubEvent,
  resolveGitHubRepositories,
  syncGitHubRepositories,
  upsertServiceRepositories,
} from '../github-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
const sourceA = '00000000-0000-4000-8000-000000000001';
const sourceB = '00000000-0000-4000-8000-000000000002';

const repository = (installationId: string, repositoryId: string, fullName: string) => ({
  installationId,
  repositoryId,
  owner: fullName.split('/')[0]!,
  name: fullName.split('/')[1]!,
  fullName,
  defaultBranch: 'main',
  private: true,
  archived: false,
  htmlUrl: `https://github.com/${fullName}`,
  pushedAt: new Date('2026-08-23T00:00:00Z'),
});

test('paged inventory reaches beyond the first hundred using stable identifiers inside tenant and connector scope', async () => {
  const source = randomUUID();
  const entries = Array.from({ length: 105 }, (_, i) =>
    repository('installation', String(i).padStart(4, '0'), `team/repo-${105 - i}`),
  );
  await syncGitHubRepositories(app.db, tenantA, source, 'installation', entries);
  await syncGitHubRepositories(app.db, tenantB, source, 'installation', [
    repository('installation', '9999', 'foreign/repo'),
  ]);
  const first = await listGitHubRepositories(app.db, tenantA, source, {
    afterRepositoryId: '',
    limit: 100,
  });
  const second = await listGitHubRepositories(app.db, tenantA, source, {
    afterRepositoryId: first.at(-1)!.repositoryId,
    limit: 100,
  });
  expect(first).toHaveLength(100);
  expect(second).toHaveLength(5);
  expect(second.map((r) => r.repositoryId)).toEqual(['0100', '0101', '0102', '0103', '0104']);
  expect(
    await listGitHubRepositories(app.db, tenantA, randomUUID(), { afterRepositoryId: '' }),
  ).toEqual([]);
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'GitHub A' },
    { id: tenantB, name: 'GitHub B' },
  ]);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(githubEvents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(serviceRepositories).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(githubRepositories).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('GitHub repository catalog', () => {
  test('synchronizes an installation as a replacement set without exposing another tenant', async () => {
    await syncGitHubRepositories(app.db, tenantA, sourceA, '101', [
      repository('101', '1', 'acme/checkout'),
      repository('101', '2', 'acme/orders'),
    ]);
    await syncGitHubRepositories(app.db, tenantB, sourceB, '202', [
      repository('202', '3', 'other/private'),
    ]);
    await syncGitHubRepositories(app.db, tenantB, sourceB, '203', [
      repository('203', '5', 'other/current'),
    ]);

    await syncGitHubRepositories(app.db, tenantA, sourceA, '101', [
      repository('101', '2', 'acme/orders'),
      repository('101', '4', 'acme/cart'),
    ]);

    expect(await countGitHubRepositories(app.db, tenantA, sourceA)).toBe(2);
    expect(
      (await listGitHubRepositories(app.db, tenantA, sourceA)).map((row) => row.fullName),
    ).toEqual(['acme/cart', 'acme/orders']);
    expect(JSON.stringify(await listGitHubRepositories(app.db, tenantA, sourceA))).not.toContain(
      'other/private',
    );
    expect(
      (await listGitHubRepositories(app.db, tenantB, sourceB)).map((row) => row.fullName),
    ).toEqual(['other/current']);
  });

  test('resolves an Argo-discovered mapping before the exact repository-name fallback', async () => {
    await upsertServiceRepositories(app.db, tenantA, [
      {
        service: 'payments-api',
        provider: 'github',
        repositoryFullName: 'ACME/Orders',
        path: 'apps/payments',
        source: 'argocd',
      },
      {
        service: 'cart',
        provider: 'github',
        repositoryFullName: 'acme/orders',
        path: 'deploy/cart',
        source: 'argocd',
      },
    ]);

    expect(await resolveGitHubRepositories(app.db, tenantA, sourceA, 'payments-api')).toMatchObject(
      [
        {
          fullName: 'acme/orders',
          source: 'mapping',
          mappingSource: 'argocd',
          role: 'deployment_config',
          confirmed: false,
        },
      ],
    );
    expect(await resolveGitHubRepositories(app.db, tenantA, sourceA, 'cart')).toMatchObject([
      { fullName: 'acme/cart', source: 'exact_name', role: 'application_source' },
      { fullName: 'acme/orders', source: 'mapping', role: 'deployment_config' },
    ]);
  });

  test('keeps exact application source when deployment-config mappings exceed the cap', async () => {
    const configs = Array.from({ length: 8 }, (_, index) =>
      repository('101', `limit-config-${index}`, `acme/config-${index}`),
    );
    await syncGitHubRepositories(app.db, tenantA, sourceA, '101', [
      repository('101', '2', 'acme/orders'),
      repository('101', '4', 'acme/cart'),
      repository('101', 'limit-app', 'acme/catalog-limit'),
      ...configs,
    ]);
    await upsertServiceRepositories(
      app.db,
      tenantA,
      configs.map((item) => ({
        service: 'catalog-limit',
        provider: 'github' as const,
        repositoryFullName: item.fullName,
        source: 'argocd',
      })),
    );

    const resolved = await resolveGitHubRepositories(app.db, tenantA, sourceA, 'catalog-limit');

    expect(resolved).toHaveLength(8);
    expect(resolved[0]).toMatchObject({
      fullName: 'acme/catalog-limit',
      source: 'exact_name',
      role: 'application_source',
    });
    expect(resolved.filter((item) => item.role === 'deployment_config')).toHaveLength(7);
  });

  test('keeps discovered application mappings ahead of an exact-name guess at the cap', async () => {
    const mapped = Array.from({ length: 8 }, (_, index) =>
      repository('101', `candidate-map-${index}`, `acme/z-map-${index}`),
    );
    await syncGitHubRepositories(app.db, tenantA, sourceA, '101', [
      repository('101', 'candidate-exact', 'acme/candidate-cap'),
      ...mapped,
    ]);
    await upsertServiceRepositories(
      app.db,
      tenantA,
      mapped.map((item) => ({
        service: 'candidate-cap',
        provider: 'github' as const,
        repositoryFullName: item.fullName,
        source: 'runtime',
      })),
    );

    const resolved = await resolveGitHubRepositories(app.db, tenantA, sourceA, 'candidate-cap');

    expect(resolved).toHaveLength(8);
    expect(resolved.every((item) => item.source === 'mapping')).toBe(true);
    expect(resolved.some((item) => item.fullName === 'acme/candidate-cap')).toBe(false);
  });
});

describe('GitHub event evidence', () => {
  test('deduplicates delivery IDs and returns only selected repository events', async () => {
    const deliveryId = randomUUID();
    const event = {
      deliveryId,
      eventType: 'push',
      repositoryId: '2',
      repositoryFullName: 'acme/orders',
      actor: 'octocat',
      ref: 'refs/heads/main',
      sha: 'abc123',
      summary: { commitCount: 2 },
      occurredAt: new Date('2026-08-23T01:00:00Z'),
    };
    expect(await recordGitHubEvent(app.db, tenantA, sourceA, event)).toBe(true);
    expect(await recordGitHubEvent(app.db, tenantA, sourceA, event)).toBe(false);
    await recordGitHubEvent(app.db, tenantB, sourceB, {
      ...event,
      repositoryFullName: 'other/private',
    });

    const rows = await recentGitHubEvents(
      app.db,
      tenantA,
      sourceA,
      ['acme/orders'],
      new Date('2026-08-23T00:00:00Z'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'push',
      repositoryFullName: 'acme/orders',
      actor: 'octocat',
      sha: 'abc123',
    });
  });
});

test('catalog search admits numeric IDs and ranks exact paths before substring matches', async () => {
  const source = randomUUID();
  const entries = Array.from({ length: 60 }, (_, i) =>
    repository('installation', String(i + 100), `aaa${i}-team/service-copy`),
  );
  entries.push(repository('installation', '71', 'team/service'));
  await syncGitHubRepositories(app.db, tenantA, source, 'installation', entries);
  expect(await listGitHubRepositories(app.db, tenantA, source, { query: '71' })).toMatchObject([
    { repositoryId: '71', fullName: 'team/service' },
  ]);
  const result = await listGitHubRepositories(app.db, tenantA, source, {
    query: 'TEAM/SERVICE',
    limit: 50,
  });
  expect(result).toHaveLength(50);
  expect(result[0]).toMatchObject({ repositoryId: '71', fullName: 'team/service' });
  expect(await listGitHubRepositories(app.db, tenantB, source, { query: '71' })).toEqual([]);
  expect(await listGitHubRepositories(app.db, tenantA, randomUUID(), { query: '71' })).toEqual([]);
  await syncGitHubRepositories(app.db, tenantA, source, 'installation', entries.slice(0, 60));
  expect(await listGitHubRepositories(app.db, tenantA, source, { query: '71' })).toEqual([]);
});
