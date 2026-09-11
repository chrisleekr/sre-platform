import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { expect, test, vi } from 'vitest';
import {
  createIncident,
  getIncident,
  incidentMessages,
  jobs,
  memberships,
  knowledgeChunks,
  EMBED_DIM,
  type Embedder,
} from '@sre/db';
import { makeSearchRunbooksTool } from '@sre/agent-tools';
import { Queue, type Job } from '@sre/queue';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import { createFixture } from './worker.fixture';
import { makeRunbookHandler } from '../runbook-consumer';
import type { StructuredGenerator } from '../engine/types';

const fixture = createFixture();
const testEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.01)),
};
const diagnosticDraft = {
  outcome: 'investigation_worthwhile',
  title: 'Node saturation',
  checked: 'CPU and I/O windows',
  ruledOut: 'None',
  openQuestions: 'Workload attribution',
  diagnosticGuide: '1. Resolve the node.\n2. Attribute load.',
};

async function setup(linked = true) {
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    service: 'node',
    severity: 'sev3',
    alertSource: 'slack',
  });
  const message = await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'human',
    kind: 'text',
    content: 'Create a runbook for this next time.',
    authorUserId: linked ? fixture.actorUserId : undefined,
    originSurface: 'slack',
  });
  const [job] = await fixture.admin.db
    .insert(jobs)
    .values({
      tenantId: fixture.tenantId,
      type: 'resume',
      status: 'processing',
      attempts: 1,
      stream: 'test',
      payload: { incidentId: incident.id, humanMessageId: message.id },
    })
    .returning();
  const queue = new Queue(fixture.admin.db, fixture.redis, {
    stream: `sre:runbook:test:${randomUUID()}`,
    group: 'runbook-test',
  });
  await queue.ensureGroup();
  const resume = vi.fn(makeFakeEngine().resume);
  const worker = fixture.workerWithEngine(
    { ...makeFakeEngine(), resume },
    {
      runbookQueue: queue,
      generator: makeFakeGenerator(() => ({
        kind: 'capture_knowledge',
        target: 'current',
        to: null,
        reason: 'Explicit request to save guidance.',
      })),
    },
  );
  return { incident, job: job! as Job, message, queue, worker, resume };
}

test('captures a linked Slack request once and publishes the persisted diagnostic document without investigating again', async () => {
  const { incident, job, worker, queue, resume } = await setup();
  await worker.handle(job, { signal: new AbortController().signal });
  await worker.handle(job, { signal: new AbortController().signal });
  expect(resume).not.toHaveBeenCalled();
  const generated = await fixture.admin.db
    .select()
    .from(jobs)
    .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`);
  expect(generated).toHaveLength(1);
  expect(generated[0]!.payload).toMatchObject({ requestedBy: fixture.actorUserId });
  const embedder: Embedder = {
    dim: EMBED_DIM,
    embed: async (texts) => texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.01)),
  };
  const handler = makeRunbookHandler({
    appDb: fixture.app.db,
    hub: fixture.hub,
    embedder,
    generator: makeFakeGenerator(() => ({
      outcome: 'investigation_worthwhile',
      title: 'Node saturation',
      checked: 'Historical I/O and current CPU are different windows.',
      ruledOut: 'Nothing conclusively.',
      openQuestions: 'Which workload drives I/O?',
      diagnosticGuide:
        '1. Resolve the node.\n2. Compare CPU, blocked tasks and disk activity.\n3. Attribute the load before changing workloads.',
    })),
  });
  try {
    expect(await queue.process('knowledge-test', handler)).toBe(1);
    const saved = await fixture.admin.db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      category: 'investigation',
      verified: false,
      sourceIncidentIds: [incident.id],
    });
    const search = makeSearchRunbooksTool({ db: fixture.app.db, embedder });
    const matches = await search.handler({ tenantId: fixture.tenantId } as never, {
      query: 'node saturation',
      k: 5,
    });
    expect(matches).toMatchObject({
      available: true,
      data: [
        expect.objectContaining({
          content: expect.stringContaining('1. Resolve the node.'),
          verified: false,
        }),
      ],
    });
    const history = await fixture.hub.history(fixture.tenantId, incident.id);
    expect(
      history.filter((row) => row.originMessageId?.startsWith('knowledge-request:')),
    ).toHaveLength(1);
    expect(history).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        summary: expect.stringContaining('Diagnostic guide saved'),
        content: expect.stringContaining('1. Resolve the node.'),
      }),
    );
    expect((await getIncident(fixture.app.db, fixture.tenantId, incident.id))!.status).toBe('open');
  } finally {
    await fixture.admin.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
  }
});

test.each(['unlinked', 'revoked'])(
  'rejects %s actors without creating a generation job',
  async (mode) => {
    const { incident, job, worker } = await setup(mode !== 'unlinked');
    if (mode === 'revoked')
      await fixture.admin.db
        .update(memberships)
        .set({ status: 'removed' })
        .where(eq(memberships.userId, fixture.actorUserId));
    try {
      await worker.handle(job, { signal: new AbortController().signal });
      expect(
        await fixture.admin.db
          .select()
          .from(jobs)
          .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`),
      ).toHaveLength(0);
      expect(await fixture.hub.history(fixture.tenantId, incident.id)).toContainEqual(
        expect.objectContaining({
          content: expect.stringContaining('active, linked workspace member'),
        }),
      );
    } finally {
      if (mode === 'revoked')
        await fixture.admin.db
          .update(memberships)
          .set({ status: 'active' })
          .where(eq(memberships.userId, fixture.actorUserId));
    }
  },
);

test('later withdrawal prevents stale capture under the human-message fence', async () => {
  const { incident, job } = await setup();
  // The semantic result is adversarial; the database fence still rejects a newly arrived message.
  const generator: StructuredGenerator = {
    async generate(_prompt, schema) {
      await fixture.admin.db.insert(incidentMessages).values({
        tenantId: fixture.tenantId,
        incidentId: incident.id,
        author: 'human',
        kind: 'text',
        content: 'Do not save it.',
        authorUserId: fixture.actorUserId,
      });
      return schema.parse({
        kind: 'capture_knowledge',
        target: 'current',
        to: null,
        reason: 'stale',
      });
    },
  };
  const fenced = fixture.workerWithEngine(makeFakeEngine(), {
    generator,
    runbookQueue: fixture.queue,
  });
  await expect(fenced.handle(job, { signal: new AbortController().signal })).rejects.toThrow(
    'New input arrived',
  );
  expect(
    await fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`),
  ).toHaveLength(0);
});

test.each(['queued', 'generating'])(
  'withdrawal while %s prevents knowledge persistence',
  async (when) => {
    const { incident, job, worker } = await setup();
    await worker.handle(job, { signal: new AbortController().signal });
    const [generation] = await fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`);
    const withdraw = () =>
      fixture.hub.append(fixture.tenantId, incident.id, {
        author: 'human',
        kind: 'text',
        content: 'Do not save this guide.',
        authorUserId: fixture.actorUserId,
      });
    if (when === 'queued') await withdraw();
    const generator: StructuredGenerator = {
      async generate(_prompt, schema) {
        if (when === 'generating') await withdraw();
        return schema.parse(diagnosticDraft);
      },
    };
    const handler = makeRunbookHandler({
      appDb: fixture.app.db,
      hub: fixture.hub,
      embedder: testEmbedder,
      generator,
    });
    try {
      await handler(generation!);
      expect(
        await fixture.admin.db
          .select()
          .from(knowledgeChunks)
          .where(eq(knowledgeChunks.tenantId, fixture.tenantId)),
      ).toHaveLength(0);
      expect(await fixture.hub.history(fixture.tenantId, incident.id)).toContainEqual(
        expect.objectContaining({ content: expect.stringContaining('No document was saved') }),
      );
    } finally {
      await fixture.admin.db
        .delete(knowledgeChunks)
        .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
    }
  },
);

test('redelivery publishes the saved document once after a post-save publication failure', async () => {
  const { incident, job, worker } = await setup();
  await worker.handle(job, { signal: new AbortController().signal });
  const [generation] = await fixture.admin.db
    .select()
    .from(jobs)
    .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`);
  const generate = vi.fn((_prompt: string) => diagnosticDraft);
  const handler = makeRunbookHandler({
    appDb: fixture.app.db,
    hub: fixture.hub,
    embedder: testEmbedder,
    generator: makeFakeGenerator(generate),
  });
  const append = vi
    .spyOn(fixture.hub, 'append')
    .mockRejectedValueOnce(new Error('publication interrupted'));
  try {
    await expect(handler(generation!)).rejects.toThrow('publication interrupted');
    await handler(generation!);
    await handler(generation!);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(
      await fixture.admin.db
        .select()
        .from(knowledgeChunks)
        .where(eq(knowledgeChunks.tenantId, fixture.tenantId)),
    ).toHaveLength(1);
    const documents = (await fixture.hub.history(fixture.tenantId, incident.id)).filter((row) =>
      row.originMessageId?.startsWith('knowledge-document:'),
    );
    expect(documents).toHaveLength(1);
    expect(documents[0]!.content).toContain('1. Resolve the node.');
  } finally {
    append.mockRestore();
    await fixture.admin.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
  }
});

test('a shared runbook has an independent idempotent document receipt in each incident', async () => {
  const first = await setup();
  const second = await setup();
  await fixture.admin.db.insert(knowledgeChunks).values({
    tenantId: fixture.tenantId,
    source: 'runbook:shared-node',
    title: 'Node diagnostics',
    content: 'Inspect current load.',
    category: 'runbook',
    sourceIncidentIds: [first.incident.id, second.incident.id],
    embedding: Array.from({ length: EMBED_DIM }, () => 0.01),
  });
  const handler = makeRunbookHandler({
    appDb: fixture.app.db,
    hub: fixture.hub,
    embedder: testEmbedder,
    generator: makeFakeGenerator(() => {
      throw new Error('Already saved');
    }),
  });
  try {
    for (const { incident, job } of [first, second]) {
      const generation = { ...job, type: 'runbook.generate', payload: { incidentId: incident.id } };
      await handler(generation);
      await handler(generation);
      expect(
        (await fixture.hub.history(fixture.tenantId, incident.id)).filter((row) =>
          row.originMessageId?.startsWith('knowledge-document:'),
        ),
      ).toHaveLength(1);
    }
  } finally {
    await fixture.admin.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
  }
});
