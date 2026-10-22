// Live-infra test like knowledge-repo.test.ts: admin seeds incidents, signals, relations and jobs;
// the repo runs as app_user so RLS binds. The embedder is a constant fake: these queries match by
// topic and monitor key, not similarity.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  withTenant,
  EMBED_DIM,
  listChunksForMonitorKeys,
  listLearningCaptureCandidates,
  getCapturedKnowledge,
  upsertRunbook,
  recordLearning,
  type DbHandle,
  type Embedder,
} from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(() => Array.from({ length: EMBED_DIM }, () => 0.1))),
};

let admin: DbHandle;
let app: DbHandle;

beforeAll(() => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
});

afterAll(async () => {
  if (admin) await admin.close();
  if (app) await app.close();
});

// Learning memory: agent-recorded facts merge per topic, recall by exact monitor key, and the
// resolve sweep's candidate query.
describe('learning memory', () => {
  let tenantL: string;
  let tenantM: string;

  async function seedIncident(
    tenant: string,
    over: { status?: string; terminalAgo?: string; purpose?: string; archived?: boolean } = {},
  ): Promise<string> {
    const status = over.status ?? 'resolved';
    const at = over.terminalAgo ? sql`now() - ${over.terminalAgo}::interval` : sql`null`;
    const rows = (await admin.db.execute(sql`
      insert into incidents (tenant_id, fingerprint, alert_source, service, severity, status, purpose,
        resolved_at, archived_at)
      values (${tenant}, ${`fp-${randomUUID()}`}, 'alertmanager', 'etcd', 'sev2', ${status},
        ${over.purpose ?? 'incident'}, ${at}, ${over.archived ? sql`now()` : sql`null`})
      returning id`)) as unknown as Array<{ id: string }>;
    return rows[0]!.id;
  }

  async function seedSignal(tenant: string, incidentId: string, monitorKey: string) {
    await admin.db.execute(sql`
      insert into incident_signals (tenant_id, incident_id, monitor_key, surface, channel,
        external_message_id, state, last_event_type, summary, content_hash, last_event_key,
        last_event_at)
      values (${tenant}, ${incidentId}, ${monitorKey}, 'slack', 'C-alerts', ${randomUUID()},
        'resolved', 'opened', 'etcd disk alert', 'h', 'k', now())`);
  }

  beforeAll(async () => {
    tenantL = randomUUID();
    tenantM = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantL, name: 'L' },
      { id: tenantM, name: 'M' },
    ]);
  }, 30_000);

  afterAll(async () => {
    await admin.db.execute(sql`delete from jobs where tenant_id in (${tenantL}, ${tenantM})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantL}, ${tenantM})`);
  });

  it('recordLearning keeps one fact per topic: the newer statement wins, provenance grows once per incident', async () => {
    const first = randomUUID();
    const second = randomUUID();
    const created = await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: 'etcd data disk on 192.168.1.202',
      statement: '/var/lib/etcd is on sda',
      basis: 'hypothesis',
      sourceIncidentId: first,
    });
    expect(created.action).toBe('created');
    const updated = await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: '  ETCD data disk   on 192.168.1.202 ',
      statement: '/var/lib/etcd is on /dev/nvme0n1p3 (the / mount); sda is only /mnt/exthdd',
      basis: 'observed',
      sourceIncidentId: second,
    });
    expect(updated).toEqual({ id: created.id, action: 'updated' });
    await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: 'etcd data disk on 192.168.1.202',
      statement: '/var/lib/etcd is on /dev/nvme0n1p3 (the / mount); sda is only /mnt/exthdd',
      basis: 'observed',
      sourceIncidentId: second,
    });
    const rows = (await withTenant(app.db, tenantL, (tx) =>
      tx.execute(
        sql`select id, category, content, occurrence_count, source_incident_ids
            from knowledge_chunks where category = 'fact'`,
      ),
    )) as unknown as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe(
      '/var/lib/etcd is on /dev/nvme0n1p3 (the / mount); sda is only /mnt/exthdd\nBasis: observed',
    );
    expect(Number(rows[0]!.occurrence_count)).toBe(2);
    expect(rows[0]!.source_incident_ids).toEqual([first, second]);
  });

  it('listChunksForMonitorKeys returns knowledge from incidents sharing a monitor key, never another tenant’s', async () => {
    const past = await seedIncident(tenantL);
    const unrelated = await seedIncident(tenantL);
    await seedSignal(tenantL, past, 'am:etcd-disk');
    await seedSignal(tenantL, unrelated, 'am:other');
    const { id } = await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: 'etcd fsync latency source',
      statement: 'fsync latency follows nightly backup IO on the same disk',
      basis: 'observed',
      sourceIncidentId: past,
    });
    await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: 'unrelated fact',
      statement: 'unrelated',
      basis: 'observed',
      sourceIncidentId: unrelated,
    });
    // Tenant M has its own incident under the same monitor key and its own fact.
    const foreign = await seedIncident(tenantM);
    await seedSignal(tenantM, foreign, 'am:etcd-disk');
    const { id: foreignId } = await recordLearning(app.db, fakeEmbedder, tenantM, {
      topic: 'tenant M private fact',
      statement: 'tenant M only',
      basis: 'observed',
      sourceIncidentId: foreign,
    });

    const hits = await listChunksForMonitorKeys(app.db, tenantL, ['am:etcd-disk'], 5);
    expect(hits.map((hit) => hit.id)).toEqual([id]);
    expect(hits[0]!.category).toBe('fact');
    const asM = await listChunksForMonitorKeys(app.db, tenantM, ['am:etcd-disk'], 5);
    expect(asM.map((hit) => hit.id)).toEqual([foreignId]);
    expect(await listChunksForMonitorKeys(app.db, tenantL, [], 5)).toEqual([]);
  });

  it('listLearningCaptureCandidates selects only recently terminal, unqueued, ordinary incidents', async () => {
    const due = await seedIncident(tenantM, { terminalAgo: '1 hour' });
    const tooFresh = await seedIncident(tenantM, { terminalAgo: '2 minutes' });
    const tooOld = await seedIncident(tenantM, { terminalAgo: '13 hours' });
    const open = await seedIncident(tenantM, { status: 'open' });
    const archived = await seedIncident(tenantM, { terminalAgo: '1 hour', archived: true });
    const healthCheck = await seedIncident(tenantM, {
      terminalAgo: '1 hour',
      purpose: 'health_check',
    });
    const merged = await seedIncident(tenantM, { terminalAgo: '1 hour' });
    await admin.db.execute(sql`
      insert into incident_relations (tenant_id, source_incident_id, target_incident_id, type,
        rationale, decided_by)
      values (${tenantM}, ${merged}, ${due}, 'merged_into', 'duplicate', 'human')`);
    const queued = await seedIncident(tenantM, { terminalAgo: '1 hour' });
    await admin.db.execute(sql`
      insert into jobs (tenant_id, type, payload, status, stream)
      values (${tenantM}, 'runbook.generate', ${JSON.stringify({ incidentId: queued })}::jsonb,
        'done', 'sre:runbook')`);
    // A job from before the incident became terminal does not suppress the resolve pass.
    const reresolved = await seedIncident(tenantM, { terminalAgo: '1 hour' });
    await admin.db.execute(sql`
      insert into jobs (tenant_id, type, payload, status, stream, created_at)
      values (${tenantM}, 'runbook.generate', ${JSON.stringify({ incidentId: reresolved })}::jsonb,
        'done', 'sre:runbook', now() - interval '2 hours')`);

    const candidates = await listLearningCaptureCandidates(app.db, tenantM);
    expect(new Set(candidates)).toEqual(new Set([due, reresolved]));
    for (const excluded of [tooFresh, tooOld, open, archived, healthCheck, merged, queued])
      expect(candidates).not.toContain(excluded);
    // RLS: tenant L sees none of tenant M's incidents.
    expect(await listLearningCaptureCandidates(app.db, tenantL)).toEqual([]);
  });

  it('getCapturedKnowledge returns only a document saved since the job, never a fact', async () => {
    const incidentId = randomUUID();
    await recordLearning(app.db, fakeEmbedder, tenantL, {
      topic: 'captured scope fact',
      statement: 'a fact is not a document',
      basis: 'observed',
      sourceIncidentId: incidentId,
    });
    expect(await getCapturedKnowledge(app.db, tenantL, incidentId)).toBeNull();
    // Minute margins absorb clock skew between this process and the database container.
    const before = new Date(Date.now() - 60_000);
    const { id } = await upsertRunbook(app.db, fakeEmbedder, tenantL, {
      title: 'Doc',
      content: 'saved document',
      sourceIncidentId: incidentId,
      category: 'investigation',
    });
    expect((await getCapturedKnowledge(app.db, tenantL, incidentId, before))?.id).toBe(id);
    const later = new Date(Date.now() + 60_000);
    expect(await getCapturedKnowledge(app.db, tenantL, incidentId, later)).toBeNull();
  });
});
