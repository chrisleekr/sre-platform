// The automatic distil pass saves an environment fact only through the same provenance gate as
// record_learning, against a real Postgres under RLS. Only the generator, hub and runbook writes are
// stubbed; evidence listing, the gate and the learning store are the production defaults.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  jobs,
  makeDb,
  tenants,
  withTenant,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { seedMembership } from '@sre/db/test-support';
import type { StructuredGenerator } from '../engine/types';
import { makeRunbookHandler } from '../runbook-consumer';
import {
  investigationDistil,
  makeIncident,
  makeJob,
  nothingDistil,
} from './runbook-consumer.fixture';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.1))),
};

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let memberId: string;

async function insert(query: ReturnType<typeof sql>): Promise<string> {
  const rows = (await admin.db.execute(query)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

const incident = () =>
  insert(sql`
    insert into incidents (tenant_id, fingerprint, alert_source, service, severity)
    values (${tenantId}, ${`fp-${randomUUID()}`}, 'alertmanager', 'etcd', 'sev2') returning id`);

const message = (incidentId: string, authorUserId: string | null) =>
  insert(sql`
    insert into incident_messages (tenant_id, incident_id, author, kind, content, author_user_id)
    values (${tenantId}, ${incidentId}, 'human', 'text', 'etcd lives on nvme', ${authorUserId})
    returning id`);

const evidence = (incidentId: string) =>
  insert(sql`
    insert into agent_tool_calls (tenant_id, incident_id, tool, input, latency_ms, outcome, output)
    values (${tenantId}, ${incidentId}, 'query_logs', '{}'::jsonb, 1, 'data', '{}'::jsonb)
    returning id`);

async function facts(): Promise<Array<{ title: string; content: string }>> {
  return (await withTenant(app.db, tenantId, (tx) =>
    tx.execute(sql`select title, content from knowledge_chunks where category = 'fact'`),
  )) as unknown as Array<{ title: string; content: string }>;
}

// Runs one automatic distil of `incidentId` whose model output is `environmentFacts`.
async function distil(incidentId: string, environmentFacts: unknown[]) {
  const generate = vi.fn(async () => ({ ...investigationDistil, environmentFacts }));
  const history = (await withTenant(app.db, tenantId, (tx) =>
    tx.execute(sql`
      select id, author, kind, content, author_user_id as "authorUserId"
      from incident_messages where incident_id = ${incidentId} order by created_at`),
  )) as unknown as Array<{ id: string; author: string; kind: string; content: string }>;
  const handler = makeRunbookHandler({
    generator: { generate } as unknown as StructuredGenerator,
    hub: { append: async () => ({}), history: async () => history },
    appDb: app.db,
    embedder: fakeEmbedder,
    getIncident: async () => makeIncident(),
    searchChunks: async () => [],
    upsertRunbook: async () => ({ id: randomUUID() }),
    listMemberEmails: async () => [],
    getCapturedKnowledge: async () => null,
    readJobPayload: async (job) => job.payload,
  });
  const job = makeJob({ tenantId, payload: { incidentId, automatic: true } });
  await handler(job);
  return String((generate.mock.calls[0] as unknown as [string])[0]);
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'distil provenance' });
  memberId = await seedMembership(
    admin.db,
    { issuer: 'https://distil.test/', subject: randomUUID() },
    tenantId,
  );
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('distil environment fact provenance', () => {
  test('drops responder and observed facts whose citations do not hold for this incident', async () => {
    const incidentId = await incident();
    const other = await incident();
    const unlinked = await message(incidentId, null);
    const foreignMessage = await message(other, memberId);
    const foreignEvidence = await evidence(other);
    const fact = (topic: string, cited: object, basis = 'responder') => ({
      topic,
      statement: 'etcd backups go to the s3 bucket ops-etcd-backups',
      basis,
      ...cited,
    });

    await distil(incidentId, [
      fact('unlinked line', { messageIds: [unlinked] }),
      fact('other incident line', { messageIds: [foreignMessage] }),
      fact('other incident evidence', { evidenceIds: [foreignEvidence] }, 'observed'),
    ]);

    expect(await facts()).toEqual([]);
  });

  test('saves a fact citing a member line or own evidence, with the ids as its source', async () => {
    const incidentId = await incident();
    const said = await message(incidentId, memberId);
    const seen = await evidence(incidentId);

    const prompt = await distil(incidentId, [
      {
        topic: 'etcd backup bucket',
        statement: 'etcd backups go to the s3 bucket ops-etcd-backups',
        basis: 'responder',
        messageIds: [said],
      },
      {
        topic: 'etcd wal disk',
        statement: 'the etcd WAL is on /dev/nvme1n1',
        basis: 'observed',
        evidenceIds: [seen],
      },
    ]);

    expect(prompt).toContain(`- [message ${said}] etcd lives on nvme`);
    expect(prompt).toContain(`- [evidence ${seen}] query_logs`);
    expect((await facts()).map((row) => row.content).sort()).toEqual([
      `etcd backups go to the s3 bucket ops-etcd-backups\nBasis: responder; source: message ${said}`,
      `the etcd WAL is on /dev/nvme1n1\nBasis: observed; source: evidence ${seen}`,
    ]);
  });

  // The production silence write against the real jobs row: it marks only a still-automatic row.
  test.each([
    ['still automatic', { automatic: true }, { automatic: true, silenced: true }, 0],
    ['adopted by a request', { requestedBy: 'u1' }, { requestedBy: 'u1' }, 1],
  ])('a nothing outcome on a row %s', async (_, stored, expected, posts) => {
    const incidentId = await incident();
    const [row] = await admin.db
      .insert(jobs)
      .values({
        tenantId,
        type: 'runbook.generate',
        status: 'processing',
        stream: 'test',
        payload: { incidentId, ...stored },
      })
      .returning({ id: jobs.id });
    const append = vi.fn(async () => ({}));
    const handler = makeRunbookHandler({
      generator: { generate: async () => nothingDistil } as unknown as StructuredGenerator,
      hub: { append, history: async () => [] },
      appDb: app.db,
      embedder: fakeEmbedder,
      getIncident: async () => makeIncident(),
      listMemberEmails: async () => [],
      getCapturedKnowledge: async () => null,
    });
    await handler(makeJob({ id: row!.id, tenantId, payload: { incidentId, automatic: true } }));
    const [after] = await admin.db
      .select({ payload: jobs.payload })
      .from(jobs)
      .where(sql`id = ${row!.id}`);
    expect(after!.payload).toEqual({ incidentId, ...expected });
    expect(append).toHaveBeenCalledTimes(posts);
  });
});
