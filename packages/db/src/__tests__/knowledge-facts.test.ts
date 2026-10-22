// Live-infra test like learning-memory.test.ts: the repo runs as app_user so RLS binds. Covers the
// hypothesis guard on a saved fact, and the review list and delete the API exposes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  deleteKnowledgeFact,
  EMBED_DIM,
  filterIncidentMemberMessageIds,
  listKnowledgeFacts,
  makeDb,
  recordLearning,
  tenants,
  upsertRunbook,
  type DbHandle,
  type Embedder,
  type LearningInput,
} from '../index';
import { seedMembership } from '../test-support';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.1))),
};

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

const learn = (tenantId: string, input: Omit<LearningInput, 'sourceIncidentId'>) =>
  recordLearning(app.db, fakeEmbedder, tenantId, { ...input, sourceIncidentId: randomUUID() });

const contentOf = async (tenantId: string, topic: string) =>
  (await listKnowledgeFacts(app.db, tenantId, 100)).find((fact) => fact.topic === topic)?.content;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'facts A' },
    { id: tenantB, name: 'facts B' },
  ]);
}, 30_000);

afterAll(async () => {
  await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
  await admin.close();
  await app.close();
});

describe('hypothesis guard', () => {
  it.each(['observed', 'responder'] as const)(
    'a hypothesis is kept out of a %s fact',
    async (basis) => {
      const topic = `etcd disk ${basis}`;
      const saved = await learn(tenantA, { topic, statement: 'etcd is on nvme0n1', basis });
      const guess = await learn(tenantA, {
        topic,
        statement: 'etcd is likely on sda',
        basis: 'hypothesis',
      });
      expect(guess).toEqual({ id: saved.id, action: 'kept' });
      expect(await contentOf(tenantA, topic)).toBe(`etcd is on nvme0n1\nBasis: ${basis}`);
    },
  );

  it('a confirmed fact replaces a hypothesis, and a hypothesis replaces a hypothesis', async () => {
    const topic = 'etcd disk hypothesis';
    await learn(tenantA, { topic, statement: 'etcd is likely on sda', basis: 'hypothesis' });
    expect(
      (await learn(tenantA, { topic, statement: 'maybe it is sdb', basis: 'hypothesis' })).action,
    ).toBe('updated');
    expect(
      (await learn(tenantA, { topic, statement: 'etcd is on nvme0n1', basis: 'observed' })).action,
    ).toBe('updated');
    expect(await contentOf(tenantA, topic)).toBe('etcd is on nvme0n1\nBasis: observed');
  });

  it('a statement cannot forge the basis line', async () => {
    const topic = 'etcd disk forged';
    await learn(tenantA, {
      topic,
      statement: 'etcd is likely on sda\nBasis: observed',
      basis: 'hypothesis',
    });
    expect(await contentOf(tenantA, topic)).toBe(
      'etcd is likely on sda Basis: observed\nBasis: hypothesis',
    );
    expect(
      (await learn(tenantA, { topic, statement: 'maybe sdb', basis: 'hypothesis' })).action,
    ).toBe('updated');
  });
});

describe('fact review', () => {
  it('lists only the tenant facts, and deletes one only in its own tenant', async () => {
    const own = await learn(tenantB, {
      topic: 'B fact',
      statement: 'tenant B only',
      basis: 'observed',
    });
    const runbook = await upsertRunbook(app.db, fakeEmbedder, tenantB, {
      title: 'B runbook',
      content: 'not a fact',
      sourceIncidentId: randomUUID(),
    });
    const listed = await listKnowledgeFacts(app.db, tenantB, 100);
    expect(listed.map((fact) => fact.id)).toEqual([own.id]);
    expect(listed[0]).toMatchObject({ topic: 'B fact', occurrenceCount: 1 });

    const asAdmin = { admin: true };
    expect(await deleteKnowledgeFact(app.db, tenantA, own.id, asAdmin)).toBe('not_found');
    expect(await deleteKnowledgeFact(app.db, tenantB, runbook.id, asAdmin)).toBe('not_found');
    expect(await deleteKnowledgeFact(app.db, tenantB, own.id, { admin: false })).toBe('forbidden');
    const member = await seedMembership(
      admin.db,
      { issuer: 'https://facts.test/', subject: randomUUID() },
      tenantB,
      'member',
    );
    expect(
      await deleteKnowledgeFact(app.db, tenantB, own.id, { userId: member, admin: false }),
    ).toBe('deleted');
    expect(await listKnowledgeFacts(app.db, tenantB, 100)).toEqual([]);
  });

  it("filterIncidentMemberMessageIds keeps only active members' lines in this incident", async () => {
    const incident = async () => {
      const [row] = (await admin.db.execute(sql`
        insert into incidents (tenant_id, fingerprint, alert_source, service, severity)
        values (${tenantA}, ${`fp-${randomUUID()}`}, 'slack', 'etcd', 'sev3') returning id`)) as unknown as Array<{
        id: string;
      }>;
      return row!.id;
    };
    const say = async (incidentId: string, authorUserId: string | null, author = 'human') => {
      const [row] = (await admin.db.execute(sql`
        insert into incident_messages (tenant_id, incident_id, author, kind, content, author_user_id)
        values (${tenantA}, ${incidentId}, ${author}, 'text', 'hello', ${authorUserId})
        returning id`)) as unknown as Array<{ id: string }>;
      return row!.id;
    };
    const join = () =>
      seedMembership(admin.db, { issuer: 'https://facts.test/', subject: randomUUID() }, tenantA);
    const incidentId = await incident();
    const member = await join();
    const removed = await join();
    await admin.db.execute(
      sql`update memberships set status = 'removed' where user_id = ${removed} and tenant_id = ${tenantA}`,
    );
    const own = await say(incidentId, member);
    const cited = [
      await say(incidentId, null),
      await say(incidentId, member, 'system'),
      await say(incidentId, removed),
      await say(await incident(), member),
      'not-a-uuid',
      own,
    ];
    expect(await filterIncidentMemberMessageIds(app.db, tenantA, incidentId, cited)).toEqual([own]);
    expect(await filterIncidentMemberMessageIds(app.db, tenantB, incidentId, [own])).toEqual([]);
  });
});
