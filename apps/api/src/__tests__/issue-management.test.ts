import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, test } from 'vitest';
import { issueActions, memberships, withTenant, gitlabProjects } from '@sre/db';
import { decideIssueAction } from '@sre/agent-tools';
import type { IssueActionView, IssueChanges } from '@sre/contracts';
import { issueFixture } from './issue-management.fixture';

const f = issueFixture();
let incidentId: string;
beforeEach(async () => {
  incidentId = await f.incident();
  f.fail(null);
  f.configure('github');
  f.writes.length = 0;
});
async function draft(
  changes: IssueChanges = { title: 'Follow-up', body: 'Evidence and next checks' },
  number?: number,
) {
  const response = await f.request(incidentId, 'drafts', {
    requestId: randomUUID(),
    draft: {
      connectorId: f.connectorId,
      repository: 'team/service',
      changes,
      ...(number ? { number } : {}),
    },
  });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as IssueActionView;
}
async function confirm(id: string) {
  const response = await f.request(incidentId, `actions/${id}`, { decision: 'confirm' });
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as IssueActionView;
}

describe.each(['github', 'gitlab'] as const)('%s authenticated issue lifecycle', (provider) => {
  test('redacts pasted credentials without corrupting issue previews, reads or outcomes', async () => {
    f.configure(provider);
    const action = await draft({ title: 'Diagnostic follow-up', body: 'password=example-value' });
    expect(action.changes.body).toBe('password=[REDACTED]');
    const result = await confirm(action.id);
    expect(result.status).toBe('succeeded');
    expect(result.result?.body).toBe('password=[REDACTED]');
    const read = await f.request(
      incidentId,
      `list?connectorId=${f.connectorId}&repository=team%2Fservice&number=12`,
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ body: 'password=[REDACTED]' });
    expect(JSON.stringify(await f.hub.history(f.tenantId, incidentId))).not.toContain(
      'example-value',
    );
  });

  test('read, preview, create, edit, close and reopen persist receipts without unconfirmed writes', async () => {
    f.configure(provider);
    const sources = await f.request(incidentId, 'sources');
    expect(await sources.json()).toMatchObject([{ type: provider }]);
    const list = await f.request(
      incidentId,
      `list?connectorId=${f.connectorId}&repository=team%2Fservice`,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);
    const create = await draft();
    expect(create.status).toBe('draft');
    expect(create.destination).toEqual({
      connectionName: provider,
      provider,
      repositoryUrl: `https://${provider === 'github' ? 'github.com' : 'gitlab.example.com'}/team/service`,
    });
    expect(f.writes).toHaveLength(0);
    const history = await f.hub.history(f.tenantId, incidentId);
    expect(history.some((row) => row.content.includes(`Confirm issue ${create.id}`))).toBe(true);
    expect(history.some((row) => row.content.includes(create.destination.repositoryUrl))).toBe(
      true,
    );
    expect((await confirm(create.id)).result).toMatchObject({
      number: 12,
      title: 'Follow-up',
      state: 'open',
    });
    expect(f.writes).toHaveLength(1);
    const assignees = provider === 'gitlab' ? ['42'] : ['responder'];
    const edit = await draft(
      { title: 'Refined follow-up', labels: ['ops', 'follow-up'], assignees },
      12,
    );
    expect(edit.before?.title).toBe('Follow-up');
    expect(f.writes).toHaveLength(1);
    expect((await confirm(edit.id)).result).toMatchObject({
      title: 'Refined follow-up',
      labels: ['ops', 'follow-up'],
      assignees,
    });
    expect((await confirm((await draft({ state: 'closed' }, 12)).id)).result?.state).toBe('closed');
    expect((await confirm((await draft({ state: 'open' }, 12)).id)).result?.state).toBe('open');
    expect(f.writes).toHaveLength(4);
    expect(f.writes.map((row) => row.method)).not.toContain('DELETE');
    if (provider === 'gitlab')
      expect(f.writes.every((row) => row.token === 'write-token')).toBe(true);
    const saved = await f.request(incidentId, 'actions');
    expect(await saved.json()).toHaveLength(4);
    expect(
      (await f.hub.history(f.tenantId, incidentId)).filter((row) =>
        row.originMessageId?.startsWith('issue-result:'),
      ),
    ).toHaveLength(4);
  });
});

test('concurrent and replayed confirmation dispatch exactly once', async () => {
  const action = await draft();
  await Promise.all([confirm(action.id), confirm(action.id), confirm(action.id)]);
  const result = await confirm(action.id);
  expect(result.status, result.error ?? '').toBe('succeeded');
  expect(f.writes).toHaveLength(1);
});

test('request replay returns the original immutable draft', async () => {
  const requestId = randomUUID();
  const body = {
    requestId,
    draft: {
      connectorId: f.connectorId,
      repository: 'team/service',
      changes: { title: 'Original' },
    },
  };
  const first = (await (await f.request(incidentId, 'drafts', body)).json()) as IssueActionView;
  body.draft.changes.title = 'Changed';
  const second = (await (await f.request(incidentId, 'drafts', body)).json()) as IssueActionView;
  expect(second.id).toBe(first.id);
  expect(second.changes.title).toBe('Original');
  expect(f.writes).toHaveLength(0);
});

test('expired and cancelled drafts produce receipts and never dispatch', async () => {
  const cancelled = await draft();
  expect(
    (await f.request(incidentId, `actions/${cancelled.id}`, { decision: 'cancel' })).status,
  ).toBe(200);
  expect((await confirm(cancelled.id)).status).toBe('cancelled');
  const expired = await draft();
  await withTenant(f.app.db, f.tenantId, (tx) =>
    tx
      .update(issueActions)
      .set({ expiresAt: new Date(0) })
      .where(eq(issueActions.id, expired.id)),
  );
  expect((await confirm(expired.id)).status).toBe('cancelled');
  expect(f.writes).toHaveLength(0);
  expect(
    (await f.hub.history(f.tenantId, incidentId)).filter((row) =>
      /cancelled|expired/.test(row.content),
    ),
  ).toHaveLength(2);
});

test('changed issue or connector invalidates the preview', async () => {
  const stale = await draft({ title: 'Replacement' }, 12);
  f.changeIssue();
  expect(await confirm(stale.id)).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/changed since/),
  });
  const changed = await draft();
  await f.changeVersion();
  expect(await confirm(changed.id)).toMatchObject({
    status: 'failed',
    error: expect.stringMatching(/connection changed/i),
  });
  expect(f.writes).toHaveLength(0);
});

test('wrong requester, workspace and revoked membership cannot confirm', async () => {
  const action = await draft();
  expect(
    (await f.request(incidentId, `actions/${action.id}`, { decision: 'confirm' }, 'peer')).status,
  ).toBe(409);
  expect(
    (await f.request(incidentId, `actions/${action.id}`, { decision: 'confirm' }, 'other')).status,
  ).toBe(404);
  await f.admin.db
    .update(memberships)
    .set({ status: 'removed' })
    .where(and(eq(memberships.tenantId, f.tenantId), eq(memberships.userId, f.actor)));
  try {
    await expect(
      decideIssueAction(f.deps, f.tenantId, incidentId, f.actor, action.id, 'confirm'),
    ).rejects.toThrow(/active/);
  } finally {
    await f.admin.db
      .update(memberships)
      .set({ status: 'active' })
      .where(and(eq(memberships.tenantId, f.tenantId), eq(memberships.userId, f.actor)));
  }
  expect(f.writes).toHaveLength(0);
});

test.each([403, 429, 500, 'network', 'invalid-json', 'invalid-shape'] as const)(
  'failure %s is safely classified and never replayed',
  async (failure) => {
    const action = await draft();
    f.fail(failure);
    const result = await confirm(action.id);
    expect(result.status).toBe(failure === 403 || failure === 429 ? 'failed' : 'unknown');
    expect(result.error).not.toContain('sensitive');
    expect((await confirm(action.id)).status).toBe(result.status);
    expect(f.writes).toHaveLength(1);
  },
);

test('newer human input fences out a queued conversation confirmation', async () => {
  const action = await draft();
  const message = await f.hub.append(f.tenantId, incidentId, {
    author: 'human',
    kind: 'text',
    content: `Confirm issue ${action.id}`,
    authorUserId: f.actor,
  });
  await f.hub.append(f.tenantId, incidentId, {
    author: 'human',
    kind: 'text',
    content: 'Wait, do not publish it',
    authorUserId: f.actor,
  });
  await expect(
    decideIssueAction(f.deps, f.tenantId, incidentId, f.actor, action.id, 'confirm', message.id),
  ).rejects.toThrow(/newer message/);
  expect(f.writes).toHaveLength(0);
});

test('invalid and out-of-scope requests return actionable errors, not a generic server failure', async () => {
  expect((await f.request(incidentId, 'drafts', { requestId: 'not-a-uuid' })).status).toBe(400);
  const response = await f.request(
    incidentId,
    `list?connectorId=${f.connectorId}&repository=other%2Frepo`,
  );
  expect(response.status).toBe(409);
  expect(((await response.json()) as { error: string }).error).toMatch(/catalog/);
  expect(f.writes).toHaveLength(0);
});

test('a persisted executing claim is not dispatched again after a service restart', async () => {
  const action = await draft();
  await withTenant(f.app.db, f.tenantId, (tx) =>
    tx.update(issueActions).set({ status: 'executing' }).where(eq(issueActions.id, action.id)),
  );
  expect(
    (await decideIssueAction({ ...f.deps }, f.tenantId, incidentId, f.actor, action.id, 'confirm'))
      .status,
  ).toBe('executing');
  expect(f.writes).toHaveLength(0);
});

test('a provider that omits requested fields cannot produce a false success receipt', async () => {
  const action = await draft({ title: 'Follow-up', labels: ['required-label'] });
  f.fail('partial');
  const result = await confirm(action.id);
  expect(result).toMatchObject({
    status: 'unknown',
    error: expect.stringContaining('labels'),
    result: { number: 12, labels: [] },
  });
  await confirm(action.id);
  expect(f.writes).toHaveLength(1);
});

test('a catalog transfer after preparation is rejected inside the dispatch transaction', async () => {
  f.configure('gitlab');
  const action = await draft();
  const deps = f.deps;
  const original = deps.resolveConnectors;
  deps.resolveConnectors = async (tenant) =>
    (await original(tenant)).map((source) => ({
      ...source,
      issues: {
        ...source.issues!,
        prepareWrite: async (reference) => {
          const prepared = await source.issues!.prepareWrite(reference);
          await f.admin.db
            .update(gitlabProjects)
            .set({ fullPath: 'outside/service' })
            .where(eq(gitlabProjects.connectorId, f.connectorId));
          return prepared;
        },
      },
    }));
  try {
    const result = await decideIssueAction(
      deps,
      f.tenantId,
      incidentId,
      f.actor,
      action.id,
      'confirm',
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/admission changed/),
    });
    expect(f.writes).toHaveLength(0);
  } finally {
    await f.admin.db
      .update(gitlabProjects)
      .set({ fullPath: 'team/service' })
      .where(eq(gitlabProjects.connectorId, f.connectorId));
  }
});

test.each([
  '/clone outside/project --with_notes',
  '/move outside/project',
  '/create_merge_request branch',
  '/cl\rone outside/project',
  '\t/close',
])('GitLab rejects description commands before preview: %s', async (body) => {
  f.configure('gitlab');
  const response = await f.request(incidentId, 'drafts', {
    requestId: randomUUID(),
    draft: {
      connectorId: f.connectorId,
      repository: 'team/service',
      changes: { title: 'Unsafe body', body },
    },
  });
  expect(response.status).toBe(409);
  expect(await response.text()).toContain('quick actions');
  expect(f.writes).toHaveLength(0);
});
