import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitlabHookAuthorizations,
  gitlabManagedHooks,
  gitlabProjects,
  gitLabManagementCredentialKey,
  memberships,
  withTenant,
} from '@sre/db';
import { ConnectorRegistry, gitLabCredentialBundle, stubConnector } from '@sre/connectors';
import { createFixture } from './connectors.fixture';
import { registerTestConnector } from './connector-registry';

const fixture = createFixture();
async function setup() {
  const id = randomUUID();
  await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    await tx.insert(connectorConfigs).values({
      id,
      name: id,
      tenantId: fixture.tenantA,
      type: 'gitlab',
      enabled: true,
      lifecycleVersion: 1,
      webhookKey: id,
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'platform',
        eventStrategy: 'managed_projects',
        eventTransport: 'direct',
      },
    });
    await fixture.secrets.put(
      fixture.tenantA,
      connectorCredentialKey(id),
      gitLabCredentialBundle('read-token', { webhookSecret: 'test-only-hook-secret' }),
      tx,
    );
    // `memberships` is RLS-exempt, so an unscoped update would demote every other suite's member.
    await tx
      .update(memberships)
      .set({ role: 'member' })
      .where(eq(memberships.tenantId, fixture.tenantA));
  });
  const api = fixture.makeConnApp();
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  const destination = `https://api.example.com/webhooks/gitlab/${id}`;
  const post = (action: string, body: Record<string, unknown> = {}) =>
    api.request(`/connectors/gitlab/${id}/management/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ destination, ...body }),
    });
  const admin = () =>
    withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx
        .update(memberships)
        .set({ role: 'admin' })
        .where(eq(memberships.tenantId, fixture.tenantA)),
    );
  return { id, api, headers, destination, post, admin };
}

test('requires an administrator and current explicit review; stores management material separately', async () => {
  const f = await setup();
  expect((await f.post('preview')).status).toBe(403);
  expect(
    (await f.post('authorize', { approved: true, managementToken: 'management-token' })).status,
  ).toBe(403);
  await f.admin();
  const preview = await f.post('preview');
  expect(preview.status).toBe(200);
  const review = (await preview.json()) as { reviewDigest: string };
  expect(
    (
      await f.post('authorize', {
        approved: true,
        managementToken: 'management-token',
        reviewDigest: 'stale',
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.post('authorize', { approved: true, managementToken: 'read-token', ...review }))
      .status,
  ).toBe(400);
  const approved = await f.post('authorize', {
    approved: true,
    managementToken: 'management-token',
    reviewDigest: review.reviewDigest,
  });
  expect(approved.status).toBe(200);
  expect(await approved.text()).not.toContain('management-token');
  expect(await fixture.secrets.get(fixture.tenantA, connectorCredentialKey(f.id))).toContain(
    'read-token',
  );
  expect(await fixture.secrets.get(fixture.tenantA, connectorCredentialKey(f.id))).not.toContain(
    'management-token',
  );
  expect(await fixture.secrets.get(fixture.tenantA, gitLabManagementCredentialKey(f.id))).toContain(
    'management-token',
  );
  const status = await f.api.request(`/connectors/gitlab/${f.id}/management`, {
    headers: f.headers,
  });
  expect(await status.json()).toMatchObject({ authorized: true, counts: { covered: 0 } });
});

test('invalidates a reviewed generation and revokes credentials without deleting external hooks', async () => {
  const f = await setup();
  await f.admin();
  const review = (await (await f.post('preview')).json()) as { reviewDigest: string };
  await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx.update(connectorConfigs).set({ lifecycleVersion: 2 }).where(eq(connectorConfigs.id, f.id)),
  );
  expect(
    (await f.post('authorize', { approved: true, managementToken: 'management-token', ...review }))
      .status,
  ).toBe(400);
  const fresh = (await (await f.post('preview')).json()) as { reviewDigest: string };
  expect(
    (await f.post('authorize', { approved: true, managementToken: 'management-token', ...fresh }))
      .status,
  ).toBe(200);
  expect((await f.post('revoke')).status).toBe(200);
  expect(
    await fixture.secrets.get(fixture.tenantA, gitLabManagementCredentialKey(f.id)),
  ).toBeNull();
  const rows = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx
      .select()
      .from(gitlabHookAuthorizations)
      .where(eq(gitlabHookAuthorizations.connectorId, f.id)),
  );
  expect(rows[0]?.revokedAt).toBeInstanceOf(Date);
  expect(rows[0]?.scope).toMatchObject({ groupPath: 'platform', policyVersion: 1 });
  expect(await fixture.secrets.get(fixture.tenantA, connectorCredentialKey(f.id))).toContain(
    'read-token',
  );
});

test('rejects a receiver for another connector and exposes no cross-tenant management state', async () => {
  const f = await setup();
  await f.admin();
  expect(
    (await f.post('preview', { destination: 'https://api.example.com/webhooks/gitlab/another' }))
      .status,
  ).toBe(400);
  const other = await f.api.request(`/connectors/gitlab/${f.id}/management`, {
    headers: fixture.bearer(await fixture.sign(fixture.orgB)),
  });
  expect(other.status).toBe(404);
  expect(await other.text()).not.toContain('platform');
});

test.each(['healthy', 'unhealthy', 'disabled', 'revoked', 'stale'] as const)(
  'retains management approval only after a healthy unchanged Retest (%s)',
  async (scenario) => {
    const status = scenario === 'unhealthy' ? 'unhealthy' : 'healthy';
    const f = await setup();
    await f.admin();
    const review = (await (await f.post('preview')).json()) as { reviewDigest: string };
    expect(
      (
        await f.post('authorize', {
          ...review,
          approved: true,
          managementToken: 'management-token',
        })
      ).status,
    ).toBe(200);
    if (scenario === 'disabled' || scenario === 'stale') {
      await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
        tx
          .update(connectorConfigs)
          .set(scenario === 'disabled' ? { enabled: false } : { lifecycleVersion: 2 })
          .where(eq(connectorConfigs.id, f.id)),
      );
    }
    const registry = new ConnectorRegistry();
    registerTestConnector(registry, 'gitlab', (config) => ({
      ...stubConnector('gitlab', config),
      probe: async () => {
        if (scenario === 'revoked') expect((await f.post('revoke')).status).toBe(200);
        return { status, reachable: true, authorized: status === 'healthy', warnings: [] };
      },
    }));
    const api = fixture.makeConnApp(undefined, undefined, undefined, {
      registry,
      discoverGroup: async () => ({
        group: {
          id: 7,
          name: 'Platform',
          fullPath: 'platform',
          webUrl: 'https://gitlab.example.com/platform',
        },
        projects: [],
      }),
    });
    const retest = await api.request(`/connectors/gitlab/${f.id}/test`, {
      method: 'POST',
      headers: f.headers,
    });
    expect(retest.status).toBe(200);
    const state = await f.api.request(`/connectors/gitlab/${f.id}/management`, {
      headers: f.headers,
    });
    expect(await state.json()).toMatchObject({ authorized: scenario === 'healthy' });
    const rows = await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx
        .select()
        .from(gitlabHookAuthorizations)
        .where(eq(gitlabHookAuthorizations.connectorId, f.id)),
    );
    expect(rows[0]?.lifecycleVersion).toBe(scenario === 'healthy' ? 2 : 1);
  },
);

test('previews catalog actions and separates confirmed missing hooks from uncertain creation', async () => {
  const f = await setup();
  await f.admin();
  const review = (await (await f.post('preview')).json()) as { reviewDigest: string };
  expect(
    (await f.post('authorize', { ...review, approved: true, managementToken: 'management-token' }))
      .status,
  ).toBe(200);
  await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    const [authority] = await tx
      .select()
      .from(gitlabHookAuthorizations)
      .where(eq(gitlabHookAuthorizations.connectorId, f.id));
    await tx.insert(gitlabProjects).values(
      Array.from({ length: 4 }, (_, index) => ({
        tenantId: fixture.tenantA,
        connectorId: f.id,
        groupId: '7',
        projectId: String(index + 1),
        name: `service-${index + 1}`,
        fullPath: `platform/service-${index + 1}`,
        webUrl: `https://gitlab.example.com/platform/service-${index + 1}`,
      })),
    );
    await tx.insert(gitlabManagedHooks).values([
      {
        tenantId: fixture.tenantA,
        connectorId: f.id,
        projectId: '1',
        projectPath: 'platform/service-1',
        hookId: '51',
        appliedAuthorizationId: authority!.id,
      },
      {
        tenantId: fixture.tenantA,
        connectorId: f.id,
        projectId: '2',
        projectPath: 'platform/service-2',
        failureCategory: 'creation_pending',
      },
      {
        tenantId: fixture.tenantA,
        connectorId: f.id,
        projectId: '3',
        projectPath: 'platform/service-3',
        failureCategory: 'creation_uncertain',
        createAttemptedAt: new Date(),
      },
      {
        tenantId: fixture.tenantA,
        connectorId: f.id,
        projectId: '5',
        projectPath: 'platform/service-5',
        failureCategory: 'creation_uncertain',
        createAttemptedAt: new Date(),
      },
    ]);
  });
  const status = await f.api.request(`/connectors/gitlab/${f.id}/management`, {
    headers: f.headers,
  });
  expect(await status.json()).toMatchObject({
    counts: { total: 4, covered: 1, missing: 1, pending: 3, failed: 2 },
  });
  expect(await (await f.post('preview')).json()).toMatchObject({
    knownProjects: 5,
    projects: [
      { project: 'platform/service-3', action: 'recover' },
      { project: 'platform/service-5', action: 'recover' },
      { project: 'platform/service-1', recordedHookId: '51', action: 'verify_or_update' },
      { project: 'platform/service-2', action: 'inspect_or_create' },
      { project: 'platform/service-4', action: 'inspect_or_create' },
    ],
  });
  const recoveryReview = (await (await f.post('preview')).json()) as {
    reviewDigest: string;
    projects: Array<{ recovery?: { recordId: string; attemptedAt: string; ownershipId: string } }>;
  };
  const recovery = recoveryReview.projects.find((project) => project.recovery)!.recovery!;
  const approve = (recoveries: unknown) =>
    f.post('authorize', {
      approved: true,
      managementToken: 'management-token',
      reviewDigest: recoveryReview.reviewDigest,
      recoveries,
    });
  expect((await approve([{ ...recovery, confirmedAbsent: false }])).status).toBe(400);
  expect(
    (await approve([{ ...recovery, recordId: randomUUID(), confirmedAbsent: true }])).status,
  ).toBe(400);
  expect(
    (
      await approve([
        { ...recovery, attemptedAt: new Date(0).toISOString(), confirmedAbsent: true },
      ])
    ).status,
  ).toBe(400);
  expect((await approve([{ ...recovery, confirmedAbsent: true }])).status).toBe(200);
  expect((await approve([{ ...recovery, confirmedAbsent: true }])).status).toBe(400);
  await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    const [hook] = await tx
      .select()
      .from(gitlabManagedHooks)
      .where(eq(gitlabManagedHooks.id, recovery.recordId));
    expect(hook).toMatchObject({ createAttemptedAt: null, failureCategory: 'retry_authorized' });
    const approvals = await tx
      .select()
      .from(gitlabHookAuthorizations)
      .where(eq(gitlabHookAuthorizations.connectorId, f.id));
    expect(approvals).toHaveLength(2);
    expect(approvals.find((row) => !row.revokedAt)?.scope).toMatchObject({
      recoveries: [
        {
          recordId: recovery.recordId,
          attemptedAt: recovery.attemptedAt,
          ownershipId: recovery.ownershipId,
          projectId: '3',
        },
      ],
    });
  });
});
