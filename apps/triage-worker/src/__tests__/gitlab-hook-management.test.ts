import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitLabManagementCredentialKey,
  gitlabHookAuthorizations,
  gitlabManagedHooks,
  memberships,
  withTenant,
} from '@sre/db';
import { createFixture } from '../../../api/src/__tests__/connectors.fixture';
import { reconcileGitLabHooks } from '../gitlab-hook-management/reconcile';
import { GITLAB_MANAGED_HOOK_EVENTS } from '@sre/contracts';

const fixture = createFixture();
const group = { id: 7, full_path: 'platform' };
const project = { id: 42, path_with_namespace: 'platform/service' };

async function setup(
  options: {
    lostCreate?: boolean;
    emptyAfterLoss?: boolean;
    pages?: boolean;
    preCreateFailure?: 'group' | 'project';
    beforeCreate?: () => Promise<void>;
    beforeHookList?: () => Promise<void>;
  } = {},
) {
  const connectorId = randomUUID();
  let remote: Record<string, unknown> | undefined;
  let moved = false;
  let groupReads = 0;
  let projectReads = 0;
  const request = vi.fn(
    async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://gitlab.example.com');
      expect(init?.headers).toMatchObject({ 'PRIVATE-TOKEN': 'management-only-token' });
      expect(init?.redirect).toBe('error');
      if (url.pathname.endsWith('/groups/7')) {
        groupReads += 1;
        if (options.preCreateFailure === 'group' && groupReads === 3)
          return new Response('', { status: 503 });
        return Response.json(group);
      }
      if (url.pathname.endsWith('/groups/7/projects'))
        return Response.json([project], { headers: { 'x-next-page': '' } });
      if (url.pathname.endsWith('/projects/42')) {
        projectReads += 1;
        if (options.preCreateFailure === 'project' && projectReads === 2)
          throw new Error('simulated pre-create connection failure');
        return Response.json({
          ...project,
          ...(moved ? { path_with_namespace: 'outside/service' } : {}),
        });
      }
      if (init?.method === 'POST') {
        await options.beforeCreate?.();
        remote = { ...JSON.parse(String(init.body)), id: 55, project_id: 42 };
        if (options.lostCreate) {
          if (options.emptyAfterLoss) remote = undefined;
          throw new Error('simulated lost response with sensitive-token');
        }
        return Response.json(remote, { status: 201 });
      }
      if (init?.method === 'PUT') {
        remote = { ...JSON.parse(String(init.body)), id: 55, project_id: 42 };
        return Response.json(remote);
      }
      if (url.pathname.endsWith('/hooks/55'))
        return remote ? Response.json(remote) : new Response('', { status: 404 });
      if (url.pathname.endsWith('/hooks')) {
        await options.beforeHookList?.();
        if (options.pages && url.searchParams.get('page') === '1')
          return Response.json([{ id: 99, project_id: 42, description: 'unrelated' }], {
            headers: { 'x-next-page': '2' },
          });
        return Response.json(remote ? [remote] : [], { headers: { 'x-next-page': '' } });
      }
      throw new Error('Unexpected management request');
    },
  );
  const fetch = Object.assign(request, { preconnect: () => undefined });
  await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    await tx.insert(connectorConfigs).values({
      id: connectorId,
      name: connectorId,
      tenantId: fixture.tenantA,
      type: 'gitlab',
      enabled: true,
      lifecycleVersion: 1,
      settings: {
        baseUrl: 'https://gitlab.example.com',
        groupId: 7,
        groupPath: 'platform',
        eventTransport: 'direct',
        eventStrategy: 'managed_projects',
      },
    });
    await tx.insert(gitlabHookAuthorizations).values({
      tenantId: fixture.tenantA,
      connectorId,
      approvedBy: randomUUID(),
      lifecycleVersion: 1,
      policyVersion: 1,
      scope: {
        baseUrl: 'https://gitlab.example.com',
        groupId: '7',
        groupPath: 'platform',
        transport: 'direct',
        destinationDigest: createHash('sha256')
          .update('https://api.example.com/webhooks/gitlab/test')
          .digest('hex'),
        events: GITLAB_MANAGED_HOOK_EVENTS,
      },
    });
    await fixture.secrets.put(
      fixture.tenantA,
      connectorCredentialKey(connectorId),
      'read-only-token',
      tx,
    );
    await fixture.secrets.put(
      fixture.tenantA,
      gitLabManagementCredentialKey(connectorId),
      JSON.stringify({
        accessToken: 'management-only-token',
        destination: 'https://api.example.com/webhooks/gitlab/test',
        webhookSecret: 'test-webhook-secret',
      }),
      tx,
    );
  });
  const deps = {
    db: fixture.app.db,
    secrets: fixture.secrets,
    fetch,
    lookup: async () => ['93.184.216.34'],
  };
  const run = (tenantId = fixture.tenantA) => reconcileGitLabHooks(deps, tenantId, connectorId);
  const hooks = () =>
    withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.select().from(gitlabManagedHooks).where(eq(gitlabManagedHooks.connectorId, connectorId)),
    );
  return {
    connectorId,
    request,
    run,
    hooks,
    remote: () => remote,
    move: () => {
      moved = true;
    },
    tamper: () => {
      remote!.description = 'someone-elses-hook';
    },
  };
}

test('creates one owned hook with separate credentials and does not repeat unchanged writes', async () => {
  const f = await setup();
  await f.run();
  expect(f.request.mock.calls).toHaveLength(8);
  expect(f.remote()).toMatchObject(GITLAB_MANAGED_HOOK_EVENTS);
  expect((await f.hooks())[0]).toMatchObject({ hookId: '55', failureCategory: null });
  await f.run();
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
  expect(await fixture.secrets.get(fixture.tenantA, connectorCredentialKey(f.connectorId))).toBe(
    'read-only-token',
  );
});

test('recovers the durable ownership marker after a lost create response without creating twice', async () => {
  const f = await setup({ lostCreate: true });
  await f.run();
  expect((await f.hooks())[0]).toMatchObject({ hookId: null });
  expect((await f.hooks())[0]?.createAttemptedAt).toBeInstanceOf(Date);
  await f.run();
  expect((await f.hooks())[0]?.hookId).toBe('55');
  await f.run();
  expect((await f.hooks())[0]?.failureCategory).toBeNull();
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test.each(['subscriptions', 'branch filter'])(
  'repairs an owned hook with changed %s once without replacing its identity',
  async (drift) => {
    const f = await setup();
    await f.run();
    const description = f.remote()!.description;
    if (drift === 'subscriptions') f.remote()!.push_events = false;
    else {
      f.remote()!.branch_filter_strategy = 'regex';
      f.remote()!.push_events_branch_filter = '^release$';
    }
    await f.run();
    expect(f.remote()).toMatchObject({ ...GITLAB_MANAGED_HOOK_EVENTS, id: 55, description });
    if (drift === 'branch filter')
      expect(f.remote()).toMatchObject({
        branch_filter_strategy: 'all_branches',
        push_events_branch_filter: '',
      });
    expect((await f.hooks())[0]).toMatchObject({ hookId: '55', failureCategory: null });
    const updates = f.request.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(updates).toHaveLength(1);
    expect(String(updates[0]![0])).toBe('https://gitlab.example.com/api/v4/projects/42/hooks/55');
    await f.run();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
  },
);

test('does not blindly retry an ambiguous create even when no hook is found', async () => {
  const f = await setup({ lostCreate: true, emptyAfterLoss: true });
  await f.run();
  await f.run();
  await f.run();
  expect((await f.hooks())[0]?.failureCategory).toBe('creation_uncertain');
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

test.each(['group', 'project'] as const)(
  'retries safely when the final %s read fails before creating a hook',
  async (preCreateFailure) => {
    const f = await setup({ preCreateFailure });
    await f.run();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    expect((await f.hooks())[0]).toMatchObject({
      createAttemptedAt: null,
      failureCategory: 'provider_unavailable',
    });
    await f.run();
    expect((await f.hooks())[0]).toMatchObject({ hookId: '55', failureCategory: null });
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    await f.run();
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);

test('scans later hook pages before creation and never adopts an unrelated hook', async () => {
  const f = await setup({ pages: true });
  await f.run();
  expect((await f.hooks())[0]?.scanPage).toBe(2);
  expect(f.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  await f.run();
  expect((await f.hooks())[0]?.hookId).toBe('55');
});

test('refuses ownership drift and a project transferred outside the approved group', async () => {
  const f = await setup();
  await f.run();
  f.tamper();
  await f.run();
  expect((await f.hooks())[0]?.failureCategory).toBe('ownership_conflict');
  f.move();
  await f.run();
  expect((await f.hooks())[0]).toMatchObject({ removed: true, failureCategory: 'out_of_scope' });
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
});

test('does no provider work for another tenant, a revoked approval or a changed generation', async () => {
  const f = await setup();
  await f.run(fixture.tenantB);
  expect(f.request).not.toHaveBeenCalled();
  await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
    tx
      .update(gitlabHookAuthorizations)
      .set({ revokedAt: new Date() })
      .where(eq(gitlabHookAuthorizations.connectorId, f.connectorId)),
  );
  await f.run();
  expect(f.request).not.toHaveBeenCalled();
  await withTenant(fixture.app.db, fixture.tenantA, async (tx) => {
    await tx
      .update(gitlabHookAuthorizations)
      .set({ revokedAt: null })
      .where(eq(gitlabHookAuthorizations.connectorId, f.connectorId));
    await tx
      .update(connectorConfigs)
      .set({ lifecycleVersion: 2 })
      .where(eq(connectorConfigs.id, f.connectorId));
  });
  await f.run();
  expect(f.request).not.toHaveBeenCalled();
});

test.each(['revoke', 'disconnect'] as const)(
  '%s waits for an in-flight write and prevents subsequent provider work',
  async (action) => {
    let release!: () => void;
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await setup({
      beforeCreate: async () => {
        reached();
        await gate;
      },
    });
    await withTenant(fixture.app.db, fixture.tenantA, (tx) =>
      tx.update(memberships).set({ role: 'admin' }),
    );
    const api = fixture.makeConnApp();
    const headers = fixture.bearer(await fixture.sign(fixture.orgA));
    const worker = f.run();
    await entered;
    let mutationFinished = false;
    const mutation = Promise.resolve(
      api.request(
        action === 'revoke'
          ? `/connectors/gitlab/${f.connectorId}/management/revoke`
          : `/connectors/gitlab/${f.connectorId}`,
        {
          method: action === 'revoke' ? 'POST' : 'DELETE',
          headers,
          ...(action === 'revoke' ? { body: '{}' } : {}),
        },
      ),
    ).then((response) => {
      mutationFinished = true;
      return response;
    });
    try {
      await vi.waitFor(async () => {
        const [blocked] = await fixture.admin.sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and (query like '%connector_configs%' or query like '%gitlab_hook_authorizations%')`;
        expect(blocked!.count).toBeGreaterThan(0);
      });
      expect(mutationFinished).toBe(false);
    } finally {
      release();
    }
    await worker;
    expect((await mutation).status).toBe(200);
    expect(
      await fixture.secrets.get(fixture.tenantA, gitLabManagementCredentialKey(f.connectorId)),
    ).toBeNull();
    const calls = f.request.mock.calls.length;
    await f.run();
    expect(f.request.mock.calls).toHaveLength(calls);
    expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  },
);

test('a queued configuration change fences creation after its durable intent commits', async () => {
  const api = fixture.makeConnApp();
  const headers = fixture.bearer(await fixture.sign(fixture.orgA));
  let mutation: Promise<Response> | undefined;
  const f = await setup({
    beforeHookList: async () => {
      if (mutation) return;
      mutation = Promise.resolve(
        api.request(`/connectors/gitlab/${f.connectorId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify({
            name: f.connectorId,
            settings: {
              baseUrl: 'https://gitlab.example.com',
              groupId: 8,
              groupPath: 'changed',
              eventStrategy: 'managed_projects',
              eventTransport: 'direct',
            },
            credential: 'read-only-token',
            webhookSecret: 'test-webhook-secret',
          }),
        }),
      );
      await vi.waitFor(async () => {
        const [blocked] = await fixture.admin.sql`
        select count(*)::int as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%connector_configs%'`;
        expect(blocked!.count).toBeGreaterThan(0);
      });
    },
  });
  await f.run();
  expect(mutation).toBeDefined();
  expect((await mutation!).status).toBe(200);
  expect((await f.hooks())[0]?.createAttemptedAt).toBeInstanceOf(Date);
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await f.run();
  expect(f.request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});
