// record_learning as the worker binds it: validation, the hypothesis rule, the per-run cap, the
// per-topic merge, cited evidence for observed facts, cited member lines for responder facts, and
// blameless cleaning, against a real Postgres under RLS. The embedder is a deterministic fake so no
// embedding server is needed.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, tenants, withTenant, EMBED_DIM, type DbHandle, type Embedder } from '@sre/db';
import { seedMembership } from '@sre/db/test-support';
import { makeInMemoryAuditSink, runTool, type ToolContext } from '@sre/agent-tools';
import { makeLearningTool } from '../platform-tools';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.1))),
};
const listMemberEmails = async () => ['alice.ops@example.com'];

let admin: DbHandle;
let app: DbHandle;
let tenantId: string;
let memberId: string;

function ctx(incidentId: string): ToolContext {
  return {
    tenantId,
    incidentId,
    service: 'etcd',
    resolveConnectors: async () => [],
    audit: makeInMemoryAuditSink(),
  };
}

const newRun = () => makeLearningTool({ db: app.db, embedder: fakeEmbedder, listMemberEmails });

async function incident(): Promise<string> {
  const rows = (await admin.db.execute(sql`
    insert into incidents (tenant_id, fingerprint, alert_source, service, severity)
    values (${tenantId}, ${`fp-${randomUUID()}`}, 'alertmanager', 'etcd', 'sev2')
    returning id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function evidence(incidentId: string, outcome = 'data'): Promise<string> {
  const rows = (await admin.db.execute(sql`
    insert into agent_tool_calls (tenant_id, incident_id, tool, input, latency_ms, outcome, output)
    values (${tenantId}, ${incidentId}, 'query_logs', '{}'::jsonb, 1, ${outcome}, '{}'::jsonb)
    returning id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function humanMessage(incidentId: string, authorUserId: string | null): Promise<string> {
  const rows = (await admin.db.execute(sql`
    insert into incident_messages (tenant_id, incident_id, author, kind, content, author_user_id)
    values (${tenantId}, ${incidentId}, 'human', 'text', 'etcd lives on nvme', ${authorUserId})
    returning id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function facts(): Promise<Array<Record<string, unknown>>> {
  return (await withTenant(app.db, tenantId, (tx) =>
    tx.execute(
      sql`select title, content, occurrence_count, source_incident_ids
          from knowledge_chunks where category = 'fact' order by created_at`,
    ),
  )) as unknown as Array<Record<string, unknown>>;
}

const factTitled = async (title: string) => (await facts()).find((row) => row.title === title);

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'learning' });
  memberId = await seedMembership(
    admin.db,
    { issuer: 'https://learning.test/', subject: randomUUID() },
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

describe('record_learning', () => {
  test('validates, refuses an unhedged hypothesis, merges per topic, strips members, and caps per run', async () => {
    const firstRun = newRun();
    const incidentA = await incident();

    expect(
      firstRun.inputSchema.safeParse({ topic: 'x', statement: 'short', basis: 'observed' }).success,
    ).toBe(false);
    expect(
      firstRun.inputSchema.safeParse({
        topic: 'etcd disk',
        statement: 'y'.repeat(501),
        basis: 'observed',
      }).success,
    ).toBe(false);

    const unhedged = await runTool(firstRun, ctx(incidentA), {
      topic: 'etcd data disk on 192.168.1.202',
      statement: '/var/lib/etcd is on sda',
      basis: 'hypothesis',
    });
    expect(unhedged).toMatchObject({ available: true, data: { recorded: false } });
    expect(await facts()).toEqual([]);

    const hedged = await runTool(firstRun, ctx(incidentA), {
      topic: 'etcd data disk on 192.168.1.202',
      statement: '/var/lib/etcd is likely on sda',
      basis: 'hypothesis',
    });
    expect(hedged).toMatchObject({ data: { recorded: true, action: 'created' } });

    // A later run, from another incident, corrects the same topic; the newer statement wins.
    const secondRun = newRun();
    const incidentB = await incident();
    const said = await humanMessage(incidentB, memberId);
    const corrected = await runTool(secondRun, ctx(incidentB), {
      topic: 'Etcd data disk on 192.168.1.202',
      statement: 'alice.ops confirmed /var/lib/etcd is on /dev/nvme0n1p3; sda is only /mnt/exthdd',
      basis: 'responder',
      messageIds: [said],
    });
    expect(corrected).toMatchObject({ data: { recorded: true, action: 'updated' } });
    expect(await factTitled('Etcd data disk on 192.168.1.202')).toMatchObject({
      content: `a responder confirmed /var/lib/etcd is on /dev/nvme0n1p3; sda is only /mnt/exthdd\nBasis: responder; source: message ${said}`,
      occurrence_count: 2,
      source_incident_ids: [incidentA, incidentB],
    });

    const evidenceB = await evidence(incidentB);
    for (const topic of ['etcd member count', 'etcd quota bytes'])
      await runTool(secondRun, ctx(incidentB), {
        topic,
        statement: `${topic} is recorded in the cluster manifest`,
        basis: 'observed',
        evidenceIds: [evidenceB],
      });
    const capped = await runTool(secondRun, ctx(incidentB), {
      topic: 'etcd snapshot schedule',
      statement: 'snapshots run nightly from the backup cron job',
      basis: 'observed',
      evidenceIds: [evidenceB],
    });
    expect(capped).toMatchObject({ data: { recorded: false } });
    expect(await factTitled('etcd snapshot schedule')).toBeUndefined();
  });

  test('an observed fact needs every cited id to be a successful read from this incident', async () => {
    const incidentId = await incident();
    const own = await evidence(incidentId);
    const failed = await evidence(incidentId, 'error');
    const foreign = await evidence(await incident());
    const fact = {
      topic: 'etcd wal disk',
      statement: 'the etcd WAL is on /dev/nvme1n1',
      basis: 'observed',
    };
    for (const evidenceIds of [
      undefined,
      [],
      [foreign],
      [randomUUID()],
      [failed],
      // One valid id must not vouch for a statement drawn from another incident's evidence.
      [foreign, own],
    ])
      expect(await runTool(newRun(), ctx(incidentId), { ...fact, evidenceIds })).toMatchObject({
        data: {
          recorded: false,
          reason: 'observed needs evidence ids of successful reads from this incident',
        },
      });
    expect(await factTitled('etcd wal disk')).toBeUndefined();

    expect(await runTool(newRun(), ctx(incidentId), { ...fact, evidenceIds: [own] })).toMatchObject(
      { data: { recorded: true } },
    );
    expect((await factTitled('etcd wal disk'))?.content).toBe(
      `the etcd WAL is on /dev/nvme1n1\nBasis: observed; source: evidence ${own}`,
    );
  });

  test('a responder fact must cite member lines from this incident, and keeps their ids', async () => {
    const incidentId = await incident();
    const own = await humanMessage(incidentId, memberId);
    // Anyone who can post in the thread produces an unattributed human line.
    const unlinked = await humanMessage(incidentId, null);
    const foreign = await humanMessage(await incident(), memberId);
    const formerMember = await seedMembership(
      admin.db,
      { issuer: 'https://learning.test/', subject: randomUUID() },
      tenantId,
    );
    const former = await humanMessage(incidentId, formerMember);
    await admin.db.execute(
      sql`update memberships set status = 'removed' where user_id = ${formerMember}`,
    );
    const fact = {
      topic: 'etcd backup bucket',
      statement: 'etcd backups go to the s3 bucket ops-etcd-backups',
      basis: 'responder',
    };
    for (const messageIds of [undefined, [unlinked], [foreign], [former], [own, unlinked]])
      expect(await runTool(newRun(), ctx(incidentId), { ...fact, messageIds })).toMatchObject({
        data: { recorded: false, reason: expect.stringContaining('responder needs messageIds') },
      });
    expect(await factTitled('etcd backup bucket')).toBeUndefined();

    expect(await runTool(newRun(), ctx(incidentId), { ...fact, messageIds: [own] })).toMatchObject({
      data: { recorded: true },
    });
    expect((await factTitled('etcd backup bucket'))?.content).toBe(
      `etcd backups go to the s3 bucket ops-etcd-backups\nBasis: responder; source: message ${own}`,
    );
  });

  test('a hypothesis never replaces a confirmed fact', async () => {
    const incidentId = await incident();
    const id = await evidence(incidentId);
    await runTool(newRun(), ctx(incidentId), {
      topic: 'etcd fsync device',
      statement: 'fsync latency comes from /dev/nvme0n1',
      basis: 'observed',
      evidenceIds: [id],
    });
    expect(
      await runTool(newRun(), ctx(incidentId), {
        topic: 'etcd fsync device',
        statement: 'fsync latency likely comes from sda',
        basis: 'hypothesis',
      }),
    ).toMatchObject({
      data: { recorded: false, reason: 'a confirmed fact exists for this topic' },
    });
    expect((await factTitled('etcd fsync device'))?.content).toContain('/dev/nvme0n1');
  });

  test('refuses a topic that names a member, and keeps a unit name that only looks like an email', async () => {
    const incidentId = await incident();
    const id = await evidence(incidentId);
    const observed = {
      statement: 'the unit restarts etcd after a crash',
      basis: 'observed',
      evidenceIds: [id],
    };
    expect(
      await runTool(newRun(), ctx(incidentId), {
        ...observed,
        topic: 'alice.ops@example.com pager',
      }),
    ).toMatchObject({ data: { recorded: false, reason: 'topic names a person' } });
    expect(
      await runTool(newRun(), ctx(incidentId), { ...observed, topic: 'etcd@node1.service' }),
    ).toMatchObject({ data: { recorded: true } });
    expect(await factTitled('etcd@node1.service')).toBeDefined();
  });
});
