import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  connectorConfigs,
  createIncident,
  issueActions,
  jobs,
  withTenant,
  syncGitLabProjects,
  knowledgeCaptureProposals,
} from '@sre/db';
import { makeFakeConnector, type IssueManager } from '@sre/connectors';
import type { Job } from '@sre/queue';
import { createFixture } from './worker.fixture';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';

const f = createFixture();
test('conversation request drafts, exact requester confirmation publishes once, and bare Yes cannot publish', async () => {
  const connectorId = randomUUID();
  await f.admin.db.insert(connectorConfigs).values({
    id: connectorId,
    tenantId: f.tenantId,
    type: 'gitlab',
    name: 'GitLab',
    settings: {},
    enabled: true,
    lifecycleVersion: 1,
  });
  const incident = await createIncident(f.app.db, f.tenantId, {
    fingerprint: randomUUID(),
    alertSource: 'slack',
    service: 'service',
    severity: 'sev3',
  });
  const repository = {
    repositoryId: '71',
    fullName: 'team/service',
    defaultBranch: 'main',
    private: true,
    archived: false,
    htmlUrl: 'https://gitlab.example.com/team/service',
  };
  const issue = {
    number: 12,
    title: 'Investigate saturation',
    body: 'Evidence and next checks',
    state: 'open' as const,
    labels: [],
    assignees: [],
    updatedAt: new Date().toISOString(),
    url: 'https://gitlab.example.com/team/service/-/issues/12',
  };
  const create = vi.fn(async () => issue);
  const port: IssueManager = {
    repositoryUrl: async () => repository.htmlUrl,
    resolve: async () => repository,
    repositories: async () => [repository],
    validateChanges() {},
    prepareWrite: async () => ({ ...port, repository }),
    get: async () => issue,
    list: async () => [issue],
    create,
    update: async () => issue,
  };
  await syncGitLabProjects(f.app.db, f.tenantId, connectorId, '7', [
    {
      groupId: '7',
      projectId: '71',
      name: 'service',
      fullPath: 'team/service',
      archived: false,
      webUrl: repository.htmlUrl,
    },
  ]);
  const source = {
    ...makeFakeConnector({
      id: connectorId,
      tenantId: f.tenantId,
      name: 'GitLab',
      type: 'gitlab',
      settings: {},
      getCredential: async () => '',
    }),
    generation: { id: connectorId, lifecycleVersion: 1 },
    issues: port,
  };
  const resume = vi.fn(makeFakeEngine().resume);
  const generator = makeFakeGenerator((prompt) => {
    const input = JSON.parse(prompt);
    return input.currentResponderMessage !== undefined
      ? {
          kind: 'manage_issue',
          target: 'current',
          to: null,
          reason: 'Explicit repository issue request.',
        }
      : {
          connectorId,
          repository: 'team/service',
          changes: { title: issue.title, body: issue.body },
        };
  });
  const worker = f.workerWithEngine(
    { ...makeFakeEngine(), resume },
    { generator, connectorProvider: () => async () => [source] },
  );
  const send = async (content: string) => {
    const message = await f.hub.append(f.tenantId, incident.id, {
      author: 'human',
      kind: 'text',
      authorUserId: f.actorUserId,
      content,
      originSurface: 'slack',
    });
    const [job] = await f.admin.db
      .insert(jobs)
      .values({
        tenantId: f.tenantId,
        type: 'resume',
        status: 'processing',
        attempts: 1,
        stream: 'test',
        payload: { incidentId: incident.id, humanMessageId: message.id },
      })
      .returning();
    await worker.handle(job! as Job, { signal: new AbortController().signal });
    return job! as Job;
  };
  await send('Create a GitLab issue in team/service with the evidence and next checks.');
  const [draft] = await withTenant(f.app.db, f.tenantId, (tx) =>
    tx.select().from(issueActions).where(eq(issueActions.incidentId, incident.id)),
  );
  expect(draft?.changes).toEqual({ title: issue.title, body: issue.body });
  expect(create).not.toHaveBeenCalled();
  expect(resume).not.toHaveBeenCalled();
  await send('Yes');
  expect(create).not.toHaveBeenCalled();
  const previous = (await f.hub.history(f.tenantId, incident.id))
    .filter((message) => message.author === 'human')
    .at(-1)!;
  const offer = await f.hub.append(f.tenantId, incident.id, {
    author: 'system',
    kind: 'reply',
    content: 'A pending platform knowledge offer.',
  });
  const [proposal] = await f.admin.db
    .insert(knowledgeCaptureProposals)
    .values({
      tenantId: f.tenantId,
      incidentId: incident.id,
      requestedBy: f.actorUserId,
      sourceMessageId: previous.id,
      fenceMessageId: previous.id,
      offerMessageId: offer.id,
    })
    .returning();
  const confirmation = await send(`Confirm issue ${draft!.id}`);
  await worker.handle(confirmation, { signal: new AbortController().signal });
  expect(create).toHaveBeenCalledTimes(1);
  const [saved] = await withTenant(f.app.db, f.tenantId, (tx) =>
    tx.select().from(issueActions).where(eq(issueActions.id, draft!.id)),
  );
  expect(saved?.status).toBe('succeeded');
  const [superseded] = await f.admin.db
    .select()
    .from(knowledgeCaptureProposals)
    .where(eq(knowledgeCaptureProposals.id, proposal!.id));
  expect(superseded?.status).toBe('superseded');
  expect(
    (await f.hub.history(f.tenantId, incident.id)).some((message) =>
      message.content.includes('Created issue team/service #12'),
    ),
  ).toBe(true);
});
