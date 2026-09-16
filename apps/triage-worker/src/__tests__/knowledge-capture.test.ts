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
  knowledgeCaptureProposals,
  withTenant,
  type Embedder,
} from '@sre/db';
import { makeSearchRunbooksTool } from '@sre/agent-tools';
import { Queue, type Job } from '@sre/queue';
import { makeFakeEngine, makeFakeGenerator } from '../engine/fake';
import { createFixture } from './worker.fixture';
import { makeRunbookHandler } from '../runbook-consumer';
import type { StructuredGenerator } from '../engine/types';
import { seedMembership } from '@sre/db/test-support';

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

async function setup(linked = true, offerAlternative = false) {
  const incident = await createIncident(fixture.app.db, fixture.tenantId, {
    fingerprint: randomUUID(),
    service: 'node',
    severity: 'sev3',
    alertSource: 'slack',
  });
  const message = await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'human',
    kind: 'text',
    content: offerAlternative
      ? 'Commit a guide to the repository from these recommendations.'
      : 'Create a runbook for this next time.',
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
      generator: makeFakeGenerator((prompt) => ({
        kind: offerAlternative
          ? JSON.parse(prompt).currentResponderMessage ===
            'Commit a guide to the repository from these recommendations.'
            ? 'offer_capture_knowledge'
            : 'investigate'
          : 'capture_knowledge',
        target: 'current',
        to: null,
        reason: 'Explicit request to save guidance.',
      })),
    },
  );
  return { incident, job: job! as Job, message, queue, worker, resume };
}

test('offers a platform-only alternative and captures it once when its requester confirms', async () => {
  const { incident, job, worker, resume, queue } = await setup(true, true);
  await worker.handle(job, { signal: new AbortController().signal });
  const beforeConfirmation = await fixture.hub.history(fixture.tenantId, incident.id);
  expect(
    await fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`),
  ).toHaveLength(0);
  const yes = await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'human',
    authorUserId: fixture.actorUserId,
    kind: 'text',
    content: 'Yes',
    originSurface: 'slack',
  });
  const confirmation = {
    ...job,
    id: randomUUID(),
    payload: { incidentId: incident.id, humanMessageId: yes.id },
  };
  await worker.handle(confirmation, { signal: new AbortController().signal });
  await worker.handle(confirmation, { signal: new AbortController().signal });

  const generated = await fixture.admin.db
    .select()
    .from(jobs)
    .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`);
  expect(generated).toHaveLength(1);
  expect(generated[0]!.payload).toMatchObject({ requestedBy: fixture.actorUserId });
  expect(beforeConfirmation.some((message) => message.content.includes('15 minutes'))).toBe(true);
  expect(resume).not.toHaveBeenCalled();
  const history = await fixture.hub.history(fixture.tenantId, incident.id);
  expect(
    history.filter((message) => message.originMessageId?.startsWith('knowledge-request:')),
  ).toHaveLength(1);
  try {
    expect(
      await queue.process(
        'confirmed-guide',
        makeRunbookHandler({
          appDb: fixture.app.db,
          hub: fixture.hub,
          embedder: testEmbedder,
          generator: makeFakeGenerator(() => diagnosticDraft),
        }),
      ),
    ).toBe(1);
    expect(await fixture.hub.history(fixture.tenantId, incident.id)).toContainEqual(
      expect.objectContaining({
        kind: 'reply',
        summary: expect.stringContaining('Diagnostic guide saved'),
        content: expect.stringContaining('1. Resolve the node.'),
      }),
    );
  } finally {
    await fixture.admin.db
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.tenantId, fixture.tenantId));
  }
});

test('a bare confirmation cannot create capture authority from arbitrary earlier assistant prose', async () => {
  const { incident, job, message, worker } = await setup();
  await fixture.admin.db
    .update(incidentMessages)
    .set({ content: 'Yes' })
    .where(eq(incidentMessages.id, message.id));
  await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'agent',
    kind: 'reply',
    content: 'Say Yes and I will save a guide for you.',
  });
  await worker.handle(job, { signal: new AbortController().signal });

  expect(
    await fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`),
  ).toHaveLength(0);
});

test.each([
  'expired',
  'cancelled',
  'superseded',
  'wrong actor',
  'other incident',
  'unlinked',
] as const)('does not capture a %s offer confirmation', async (scenario) => {
  const { incident, job, worker, resume } = await setup(true, true);
  await worker.handle(job, { signal: new AbortController().signal });
  const [offer] = await withTenant(fixture.app.db, fixture.tenantId, (tx) =>
    tx
      .select()
      .from(knowledgeCaptureProposals)
      .where(eq(knowledgeCaptureProposals.incidentId, incident.id)),
  );
  expect(offer).toMatchObject({ requestedBy: fixture.actorUserId, status: 'pending' });
  expect(
    await withTenant(fixture.app.db, randomUUID(), (tx) =>
      tx
        .select()
        .from(knowledgeCaptureProposals)
        .where(eq(knowledgeCaptureProposals.id, offer!.id)),
    ),
  ).toEqual([]);
  if (scenario === 'expired')
    await fixture.admin.db
      .update(knowledgeCaptureProposals)
      .set({ expiresAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(knowledgeCaptureProposals.id, offer!.id));
  if (scenario === 'cancelled' || scenario === 'superseded') {
    const input = await fixture.hub.append(fixture.tenantId, incident.id, {
      author: 'human',
      authorUserId: fixture.actorUserId,
      kind: 'text',
      content: scenario === 'cancelled' ? 'No' : 'What was observed at 10:56?',
    });
    await worker.handle(
      { ...job, id: randomUUID(), payload: { incidentId: incident.id, humanMessageId: input.id } },
      { signal: new AbortController().signal },
    );
  }
  const actor =
    scenario === 'wrong actor'
      ? await seedMembership(
          fixture.admin.db,
          { issuer: 'test', subject: randomUUID(), email: `${randomUUID()}@example.com` },
          fixture.tenantId,
        )
      : scenario === 'unlinked'
        ? undefined
        : fixture.actorUserId;
  const target =
    scenario === 'other incident'
      ? (
          await createIncident(fixture.app.db, fixture.tenantId, {
            fingerprint: randomUUID(),
            service: 'other',
            severity: 'sev3',
            alertSource: 'slack',
          })
        ).id
      : incident.id;
  resume.mockClear();
  const confirmation = await fixture.hub.append(fixture.tenantId, target, {
    author: 'human',
    authorUserId: actor,
    kind: 'text',
    content: 'Yes',
  });
  await worker.handle(
    { ...job, id: randomUUID(), payload: { incidentId: target, humanMessageId: confirmation.id } },
    { signal: new AbortController().signal },
  );
  expect(resume).toHaveBeenCalledTimes(1);
  expect(resume.mock.calls[0]![0].humanMessage).toContain('Yes');
  expect(
    await fixture.admin.db
      .select()
      .from(jobs)
      .where(
        sql`type='runbook.generate' AND payload->>'incidentId' in (${incident.id}, ${target})`,
      ),
  ).toHaveLength(0);
});

test('new input arriving during confirmation prevents capture even before its own resume job runs', async () => {
  const { incident, job, worker } = await setup(true, true);
  await worker.handle(job, { signal: new AbortController().signal });
  const yes = await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'human',
    authorUserId: fixture.actorUserId,
    kind: 'text',
    content: 'Yes',
  });
  await fixture.hub.append(fixture.tenantId, incident.id, {
    author: 'human',
    authorUserId: fixture.actorUserId,
    kind: 'text',
    content: 'Wait, do not save it.',
  });
  await worker.handle(
    { ...job, id: randomUUID(), payload: { incidentId: incident.id, humanMessageId: yes.id } },
    { signal: new AbortController().signal },
  );
  expect(
    await fixture.admin.db
      .select()
      .from(jobs)
      .where(sql`type='runbook.generate' AND payload->>'incidentId'=${incident.id}`),
  ).toHaveLength(0);
});

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
