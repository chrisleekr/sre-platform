import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  connectorConfigs,
  deployments,
  gitlabEvents,
  gitlabProjects,
  makeDb,
  nextGitLabPollProjects,
  resetGitLabPolling,
  gitLabPollingCoverage,
  upsertGitLabProject,
  markGitLabProjectRemoved,
  tenants,
  withTenant,
  type DbHandle,
} from '@sre/db';
import type { ConnectorPollEvidence, NormalizedSnapshot } from '@sre/connectors';
import { persistDeploys } from '../persist-deploys';

const tenantId = randomUUID(),
  connectorId = randomUUID();
const observedAt = new Date('2026-09-08T00:00:00Z');
let admin: DbHandle, app: DbHandle;

function snapshot(kind: string, metadata: Record<string, unknown>): NormalizedSnapshot {
  return {
    tenantId,
    source: 'gitlab',
    entityId: '42',
    observedAt,
    metrics: {},
    metadata: { kind, projectId: '42', ...metadata },
  };
}
function batch() {
  return [
    snapshot('gitlab-project', {
      groupId: '7',
      name: 'service',
      fullPath: 'platform/service',
      webUrl: 'https://gitlab.example.com/platform/service',
      archived: false,
    }),
    snapshot('gitlab-event', {
      eventType: 'pipeline',
      repo: 'platform/service',
      details: { id: '11', status: 'success', sha: 'abc123', at: observedAt.toISOString() },
    }),
    snapshot('gitlab-deployment', {
      providerId: '12',
      repo: 'platform/service',
      sha: 'abc123',
      status: 'success',
      deployedAt: observedAt.toISOString(),
    }),
    snapshot('gitlab-poll-state', {
      cursor: { turn: 1, pipeline: { page: 2, pending: true } },
      active: true,
      failureCategory: null,
    }),
  ];
}

beforeAll(async () => {
  admin = makeDb(process.env.DATABASE_URL!);
  app = makeDb(process.env.APP_DATABASE_URL!);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'GitLab polling persistence' });
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(connectorConfigs).values({
      id: connectorId,
      tenantId,
      type: 'gitlab',
      enabled: true,
      lifecycleVersion: 1,
      settings: { groupId: 7, groupPath: 'platform', eventStrategy: 'system' },
    }),
  );
});
afterAll(async () => {
  if (admin) {
    await admin.db.delete(deployments).where(eq(deployments.tenantId, tenantId));
    await admin.db.delete(gitlabEvents).where(eq(gitlabEvents.tenantId, tenantId));
    await admin.db.delete(gitlabProjects).where(eq(gitlabProjects.tenantId, tenantId));
    await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  await app?.close();
});

test('atomically saves polling evidence, deployments, catalog and project cursors without claiming webhook delivery', async () => {
  const evidence: ConnectorPollEvidence = { expectedCursor: {}, cursor: { revision: 1 } };
  expect(
    await persistDeploys(app.db, tenantId, batch(), 'gitlab', evidence, {
      id: connectorId,
      lifecycleVersion: 1,
    }),
  ).toBe(true);
  const [connector] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(connectorConfigs),
  );
  expect(connector?.pollCursor).toEqual({ revision: 1 });
  expect(connector?.eventCount).toBe(0);
  expect(connector?.eventSucceededAt).toBeNull();
  const [event] = await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabEvents));
  expect(event).toMatchObject({
    eventType: 'pipeline',
    sha: 'abc123',
    summary: { provenance: 'polling', observedAt: observedAt.toISOString() },
  });
  const rows = await withTenant(app.db, tenantId, (tx) => tx.select().from(deployments));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ providerId: '12', source: 'gitlab' });
  const [project] = await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabProjects));
  expect(project).toMatchObject({
    pollCursor: { turn: 1, pipeline: { page: 2, pending: true } },
    pollActive: true,
    pollSucceededAt: observedAt,
  });
  expect(await nextGitLabPollProjects(app.db, randomUUID(), connectorId)).toEqual([]);
  const coverage = await gitLabPollingCoverage(app.db, tenantId, connectorId);
  expect(coverage.oldestReadAt).toBe(observedAt.toISOString());
  expect(coverage).toMatchObject({
    total: 1,
    notChecked: 0,
    failed: 0,
    backlog: 1,
    projects: [{ project: 'platform/service', backlog: true, lastSuccessAt: observedAt }],
  });
  expect(await gitLabPollingCoverage(app.db, randomUUID(), connectorId)).toMatchObject({
    total: 0,
    projects: [],
  });
});

test('rejects stale concurrent cursor results and deduplicates unchanged observations across successful polls', async () => {
  expect(
    await persistDeploys(
      app.db,
      tenantId,
      batch(),
      'gitlab',
      { expectedCursor: {}, cursor: { revision: 2 } },
      { id: connectorId, lifecycleVersion: 1 },
    ),
  ).toBe(false);
  const next = batch().map((s) => ({ ...s, observedAt: new Date(observedAt.getTime() + 1000) }));
  expect(
    await persistDeploys(
      app.db,
      tenantId,
      next,
      'gitlab',
      { expectedCursor: { revision: 1 }, cursor: { revision: 2 } },
      { id: connectorId, lifecycleVersion: 1 },
    ),
  ).toBe(true);
  expect(await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabEvents))).toHaveLength(
    1,
  );
});

test('rolls back the cursor and evidence together if any observation belongs to another tenant', async () => {
  const changed = batch().map((s) => ({ ...s, tenantId: randomUUID() }));
  await expect(
    persistDeploys(
      app.db,
      tenantId,
      changed,
      'gitlab',
      { expectedCursor: { revision: 2 }, cursor: { revision: 3 } },
      { id: connectorId, lifecycleVersion: 1 },
    ),
  ).rejects.toThrow('tenant/source mismatch');
  const [connector] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(connectorConfigs),
  );
  expect(connector?.pollCursor).toEqual({ revision: 2 });
});

test('reserves work for quiet projects even with an active-project backlog', async () => {
  await withTenant(app.db, tenantId, (tx) =>
    tx.insert(gitlabProjects).values(
      Array.from({ length: 8 }, (_, index) => ({
        tenantId,
        connectorId,
        groupId: '7',
        projectId: String(100 + index),
        name: `service-${index}`,
        fullPath: `platform/service-${index}`,
        webUrl: `https://gitlab.example.com/platform/service-${index}`,
        pollActive: index >= 2,
        pollAttemptedAt: index < 2 ? null : observedAt,
      })),
    ),
  );
  const selected = await nextGitLabPollProjects(app.db, tenantId, connectorId);
  expect(selected).toHaveLength(4);
  expect(selected.map((p) => p.repositoryId)).toEqual(expect.arrayContaining(['100', '101']));
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(gitlabProjects)
      .set({ pollAttemptedAt: new Date() })
      .where(
        and(
          eq(gitlabProjects.connectorId, connectorId),
          sql`${gitlabProjects.projectId} in ('100', '101')`,
        ),
      ),
  );
  const next = await nextGitLabPollProjects(app.db, tenantId, connectorId);
  expect(next.map((p) => p.repositoryId)).not.toContain('100');
  expect(next.map((p) => p.repositoryId)).not.toContain('101');
});

test('retains last successful project evidence on a partial failure and stops disabled generations', async () => {
  const partial = [
    snapshot('gitlab-poll-state', {
      cursor: { turn: 3 },
      failureCategory: 'permission_denied',
      active: false,
    }),
  ];
  expect(
    await persistDeploys(
      app.db,
      tenantId,
      partial,
      'gitlab',
      { expectedCursor: { revision: 2 }, cursor: { revision: 3 }, errorCount: 1 },
      { id: connectorId, lifecycleVersion: 1 },
    ),
  ).toBe(true);
  const [project] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(gitlabProjects).where(eq(gitlabProjects.projectId, '42')),
  );
  expect(project?.pollSucceededAt).toEqual(new Date(observedAt.getTime() + 1000));
  expect(project?.pollFailureCategory).toBe('permission_denied');
  await withTenant(app.db, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({ enabled: false, lifecycleVersion: 2 })
      .where(eq(connectorConfigs.id, connectorId)),
  );
  expect(
    await persistDeploys(
      app.db,
      tenantId,
      batch(),
      'gitlab',
      { expectedCursor: { revision: 3 }, cursor: { revision: 4 } },
      { id: connectorId, lifecycleVersion: 1 },
    ),
  ).toBe(false);
});

test('resets cursors for strategy changes and hides the old catalog only when scope changes', async () => {
  await resetGitLabPolling(app.db, tenantId, connectorId, false);
  const [project] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(gitlabProjects).where(eq(gitlabProjects.projectId, '42')),
  );
  expect(project).toMatchObject({
    pollCursor: null,
    pollAttemptedAt: null,
    pollSucceededAt: null,
    pollActive: false,
    removedAt: null,
  });
  await resetGitLabPolling(app.db, tenantId, connectorId, true);
  expect(await nextGitLabPollProjects(app.db, tenantId, connectorId)).toEqual([]);
  expect(await withTenant(app.db, tenantId, (tx) => tx.select().from(gitlabEvents))).toHaveLength(
    1,
  );
});

test('does not resurrect a transferred project from a catalog page fetched before the webhook', async () => {
  const project = {
    projectId: '999',
    groupId: '7',
    name: 'moved',
    fullPath: 'platform/moved',
    webUrl: 'https://gitlab.example.com/platform/moved',
    archived: false,
  };
  await upsertGitLabProject(app.db, tenantId, connectorId, project);
  await markGitLabProjectRemoved(app.db, tenantId, connectorId, project.projectId);
  await upsertGitLabProject(app.db, tenantId, connectorId, project, observedAt);
  const [row] = await withTenant(app.db, tenantId, (tx) =>
    tx.select().from(gitlabProjects).where(eq(gitlabProjects.projectId, project.projectId)),
  );
  expect(row?.removedAt).toBeInstanceOf(Date);
});
