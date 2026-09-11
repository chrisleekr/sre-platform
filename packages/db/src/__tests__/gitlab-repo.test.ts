import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { gitlabEvents, gitlabProjects, serviceRepositories, tenants } from '../schema';
import { makeDb, type DbHandle } from '../client';
import {
  countGitLabProjects,
  listGitLabProjects,
  recentGitLabEvents,
  recordGitLabEvent,
  resolveGitLabProjects,
  syncGitLabProjects,
} from '../gitlab-repo';
import { upsertServiceRepositories } from '../github-repo';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;
const sourceA = '00000000-0000-4000-8000-000000000001';
const sourceB = '00000000-0000-4000-8000-000000000002';

const project = (groupId: string, projectId: string, fullPath: string) => ({
  groupId,
  projectId,
  name: fullPath.split('/').at(-1)!,
  fullPath,
  defaultBranch: 'main',
  visibility: 'private',
  archived: false,
  webUrl: `https://gitlab.example.com/${fullPath}`,
  lastActivityAt: new Date('2026-08-24T00:00:00Z'),
});

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'GitLab A' },
    { id: tenantB, name: 'GitLab B' },
  ]);
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(gitlabEvents).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(serviceRepositories).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(gitlabProjects).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('GitLab group project catalog', () => {
  test('reconciles the recursive group inventory without exposing another tenant', async () => {
    await syncGitLabProjects(app.db, tenantA, sourceA, '7', [
      project('7', '41', 'platform/checkout'),
      project('7', '42', 'platform/services/orders'),
    ]);
    await syncGitLabProjects(app.db, tenantB, sourceB, '8', [project('8', '90', 'private/secret')]);
    await syncGitLabProjects(app.db, tenantB, sourceB, '9', [
      project('9', '91', 'private/current'),
    ]);
    await syncGitLabProjects(app.db, tenantA, sourceA, '7', [
      project('7', '42', 'platform/services/orders'),
      project('7', '43', 'platform/cart'),
    ]);

    expect(await countGitLabProjects(app.db, tenantA, sourceA)).toBe(2);
    expect((await listGitLabProjects(app.db, tenantA, sourceA)).map((row) => row.fullName)).toEqual(
      ['platform/cart', 'platform/services/orders'],
    );
    expect(JSON.stringify(await listGitLabProjects(app.db, tenantA, sourceA))).not.toContain(
      'private/secret',
    );
    expect((await listGitLabProjects(app.db, tenantB, sourceB)).map((row) => row.fullName)).toEqual(
      ['private/current'],
    );
  });

  test('resolves Argo CD mappings before exact project-name fallback', async () => {
    await upsertServiceRepositories(app.db, tenantA, [
      {
        service: 'payments-api',
        provider: 'gitlab',
        repositoryFullName: 'PLATFORM/SERVICES/ORDERS',
        path: 'deploy/payments',
        source: 'argocd',
      },
      {
        service: 'cart',
        provider: 'gitlab',
        repositoryFullName: 'platform/services/orders',
        path: 'deploy/cart',
        source: 'argocd',
      },
    ]);

    expect(await resolveGitLabProjects(app.db, tenantA, sourceA, 'payments-api')).toMatchObject([
      {
        fullName: 'platform/services/orders',
        source: 'mapping',
        mappingSource: 'argocd',
        role: 'deployment_config',
        confirmed: false,
      },
    ]);
    expect(await resolveGitLabProjects(app.db, tenantA, sourceA, 'cart')).toMatchObject([
      { fullName: 'platform/cart', source: 'exact_name', role: 'application_source' },
      {
        fullName: 'platform/services/orders',
        source: 'mapping',
        role: 'deployment_config',
      },
    ]);
  });

  test('keeps exact application source when deployment-config mappings exceed the cap', async () => {
    const configs = Array.from({ length: 8 }, (_, index) =>
      project('7', `limit-config-${index}`, `platform/config-${index}`),
    );
    await syncGitLabProjects(app.db, tenantA, sourceA, '7', [
      project('7', '42', 'platform/services/orders'),
      project('7', '43', 'platform/cart'),
      project('7', 'limit-app', 'platform/catalog-limit'),
      ...configs,
    ]);
    await upsertServiceRepositories(
      app.db,
      tenantA,
      configs.map((item) => ({
        service: 'catalog-limit',
        provider: 'gitlab' as const,
        repositoryFullName: item.fullPath,
        source: 'argocd',
      })),
    );

    const resolved = await resolveGitLabProjects(app.db, tenantA, sourceA, 'catalog-limit');

    expect(resolved).toHaveLength(8);
    expect(resolved[0]).toMatchObject({
      fullName: 'platform/catalog-limit',
      source: 'exact_name',
      role: 'application_source',
    });
    expect(resolved.filter((item) => item.role === 'deployment_config')).toHaveLength(7);
  });

  test('keeps discovered application mappings ahead of an exact-name guess at the cap', async () => {
    const mapped = Array.from({ length: 8 }, (_, index) =>
      project('7', `candidate-map-${index}`, `platform/z-map-${index}`),
    );
    await syncGitLabProjects(app.db, tenantA, sourceA, '7', [
      project('7', 'candidate-exact', 'platform/candidate-cap'),
      ...mapped,
    ]);
    await upsertServiceRepositories(
      app.db,
      tenantA,
      mapped.map((item) => ({
        service: 'candidate-cap',
        provider: 'gitlab' as const,
        repositoryFullName: item.fullPath,
        source: 'runtime',
      })),
    );

    const resolved = await resolveGitLabProjects(app.db, tenantA, sourceA, 'candidate-cap');

    expect(resolved).toHaveLength(8);
    expect(resolved.every((item) => item.source === 'mapping')).toBe(true);
    expect(resolved.some((item) => item.fullName === 'platform/candidate-cap')).toBe(false);
  });
});

describe('GitLab webhook evidence', () => {
  test('deduplicates retries and returns only selected project events', async () => {
    const deliveryId = randomUUID();
    const event = {
      deliveryId,
      eventType: 'pipeline',
      action: 'failed',
      projectId: '42',
      projectFullPath: 'platform/services/orders',
      actor: 'deploy-bot',
      ref: 'main',
      sha: 'abc123',
      summary: { status: 'failed' },
      occurredAt: new Date('2026-08-24T01:00:00Z'),
    };
    expect(await recordGitLabEvent(app.db, tenantA, sourceA, event)).toBe(true);
    expect(await recordGitLabEvent(app.db, tenantA, sourceA, event)).toBe(false);
    await recordGitLabEvent(app.db, tenantB, sourceB, {
      ...event,
      projectFullPath: 'private/secret',
    });

    const rows = await recentGitLabEvents(
      app.db,
      tenantA,
      sourceA,
      ['platform/services/orders'],
      new Date('2026-08-24T00:00:00Z'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: 'pipeline',
      action: 'failed',
      repositoryFullName: 'platform/services/orders',
      actor: 'deploy-bot',
      sha: 'abc123',
    });
  });
});
