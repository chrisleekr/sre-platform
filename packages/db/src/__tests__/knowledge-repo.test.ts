// Live-infra test (mirrors incident-repo.test.ts and connector-provider.test.ts): the admin
// (superuser) role seeds the control-plane tenants and cleans up; the repo runs as app_user so
// FORCE ROW LEVEL SECURITY binds. A fake, deterministic Embedder maps each text to a near-one-hot
// EMBED_DIM vector keyed by the first seed term it contains, so a query and a chunk that share a
// term get cosine distance ~0. That makes ranking predictable offline (no self-hosted embedder)
// and proves search returns the most-similar chunk first, scoped to the caller, with bidirectional RLS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  knowledgeChunks,
  insertKnowledgeChunks,
  searchKnowledgeChunks,
  withTenant,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '../index';
// Namespace import for the Phase-B additions (searchChunks/upsertRunbook). A named import of a
// not-yet-exported symbol is an ESM link error that would fail the whole module (breaking the C9
// regression tests too); via the namespace they read as `undefined` until Phase B, so the new
// tests fail per-assertion with "searchChunks is not a function" (a clean RED) while the existing
// searchKnowledgeChunks tests still load and pass.
import * as knowledgeRepo from '../index';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

// Seed terms map to distinct "hot" dimensions. A text's vector spikes the dimension of the first
// seed term it contains, so a query and a chunk that share a term get an identical vector (cosine
// distance 0) while unrelated terms stay far apart. Deterministic, offline, no embedding server.
const SEED_TERMS = ['database', 'network', 'disk'] as const;
const BASELINE = 0.01;

function fakeVector(text: string): number[] {
  const vec = Array.from({ length: EMBED_DIM }, () => BASELINE);
  const lower = text.toLowerCase();
  const hit = SEED_TERMS.findIndex((term) => lower.includes(term));
  vec[hit === -1 ? SEED_TERMS.length : hit] = BASELINE + 1;
  return vec;
}

const fakeEmbedder: Embedder = {
  dim: EMBED_DIM,
  embed: (texts) => Promise.resolve(texts.map(fakeVector)),
};

const dbChunk = {
  source: 'runbook/db-pool-exhaustion.md',
  content:
    'When the database connection pool is exhausted, restart pgbouncer and kill long-running database transactions.',
};
const networkChunk = {
  source: 'runbook/network-partition.md',
  content:
    'A network partition across availability zones causes cross-AZ network timeouts; check the network ACLs.',
};
const diskChunk = {
  source: 'runbook/disk-pressure.md',
  content: 'Disk pressure fills the data volume; prune old logs to reclaim disk space.',
};
const DB_QUERY = 'the database connection pool keeps getting exhausted';
const tenantASources = [dbChunk.source, networkChunk.source, diskChunk.source];

let admin: DbHandle;
let app: DbHandle;
let tenantA: string;
let tenantB: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantA = randomUUID();
  tenantB = randomUUID();
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'A' },
    { id: tenantB, name: 'B' },
  ]);
  // tenantA seeds three runbook chunks under app_user RLS. tenantB stays empty until the isolation
  // test seeds it, so the first test can assert an empty (RLS-denied) result for tenantB.
  await insertKnowledgeChunks(app.db, fakeEmbedder, tenantA, [dbChunk, networkChunk, diskChunk]);
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id in (${tenantA}, ${tenantB})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantA}, ${tenantB})`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('searchKnowledgeChunks RAG + RLS', () => {
  it('ranks most-similar chunks for the calling tenant only', async () => {
    expect(EMBED_DIM).toBe(1024);
    const results = await searchKnowledgeChunks(app.db, fakeEmbedder, tenantA, DB_QUERY, 3);
    expect(results).toHaveLength(3);
    // The DB runbook shares the query's seed term, so it ranks first.
    expect(results[0]!.source).toBe(dbChunk.source);
    expect(results[0]!.content).toBe(dbChunk.content);
    for (const r of results) {
      expect(typeof r.source).toBe('string');
      expect(typeof r.content).toBe('string');
      expect(r.createdAt).toBeInstanceOf(Date);
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score)).toBe(true);
    }
    // tenantB seeded nothing: RLS yields an empty result, never tenantA's chunks.
    const asTenantB = await searchKnowledgeChunks(app.db, fakeEmbedder, tenantB, DB_QUERY, 3);
    expect(asTenantB).toEqual([]);
  });

  it('isolates results bidirectionally: neither tenant sees the other (RLS)', async () => {
    const tenantBChunk = {
      source: 'runbook/tenantB-db-secret.md',
      content: 'TenantB private database failover steps for a database outage.',
    };
    await insertKnowledgeChunks(app.db, fakeEmbedder, tenantB, [tenantBChunk]);

    // tenantA must never surface tenantB's chunk, even though it is the most similar to the query.
    const asTenantA = await searchKnowledgeChunks(app.db, fakeEmbedder, tenantA, DB_QUERY, 5);
    expect(asTenantA.map((r) => r.source)).not.toContain(tenantBChunk.source);
    expect(asTenantA.every((r) => tenantASources.includes(r.source))).toBe(true);
    expect(asTenantA.map((r) => r.source)).toContain(dbChunk.source);

    // tenantB sees only its own single chunk.
    const asTenantB = await searchKnowledgeChunks(app.db, fakeEmbedder, tenantB, DB_QUERY, 5);
    expect(asTenantB).toHaveLength(1);
    expect(asTenantB[0]!.source).toBe(tenantBChunk.source);
  });

  it('rejects a forged cross-tenant insert via the WITH CHECK policy (write isolation)', async () => {
    const [embedding] = await fakeEmbedder.embed(['cross-tenant write attempt']);
    // Raw insert, not insertKnowledgeChunks (which stamps the session tenant): under tenantA's
    // session, forge tenantB's id. app_user holds INSERT, so the rejection is the tenant_isolation
    // WITH CHECK policy, not a privilege error; tenantB exists, so no FK error masks it.
    await expect(
      withTenant(app.db, tenantA, (tx) =>
        tx.insert(knowledgeChunks).values({
          tenantId: tenantB,
          source: 'runbook/forged.md',
          content: 'forged cross-tenant row',
          embedding: embedding!,
        }),
      ),
    ).rejects.toThrow();
  });
});

// pgvector literal for a raw INSERT: reuse the deterministic fake vector so a chunk sharing a seed
// term with the query gets cosine distance ~0. Format is pgvector's text form `[v0,v1,...]`.
function vecLiteral(text: string): string {
  return `[${fakeVector(text).join(',')}]`;
}

// searchChunks generalizes searchKnowledgeChunks into a category-discriminated corpus. These tests
// seed categorized rows with an explicit `category` column via raw SQL (RED now: the column does
// not exist yet), then exercise the new searchChunks API (RED now: not a function yet).
describe('searchChunks (category-discriminated retrieval + RLS)', () => {
  let tenantC: string;
  let tenantD: string;

  // tenantC runbook corpus: db shares the query's seed term (score ~1), net/disk do not (score ~0.11).
  const cRunbooks = [
    {
      source: 'runbook/c-db.md',
      content: 'the database connection pool is exhausted; restart pgbouncer',
    },
    {
      source: 'runbook/c-net.md',
      content: 'a network partition across availability zones causes timeouts',
    },
    { source: 'runbook/c-disk.md', content: 'disk pressure fills the data volume; prune old logs' },
  ];
  const cRunbookSources = cRunbooks.map((r) => r.source);
  // Same tenant, DIFFERENT category, sharing the query's seed term: proves the discriminator filters
  // rather than returning everything (without a category WHERE this would rank first).
  const cPostmortem = {
    source: 'postmortem/c-db.md',
    content: 'database outage postmortem timeline',
  };
  const dRunbook = {
    source: 'runbook/d-secret.md',
    content: 'tenantD private database failover steps',
  };

  async function seedChunk(tenant: string, source: string, content: string, category: string) {
    await withTenant(app.db, tenant, (tx) =>
      tx.execute(
        sql`insert into knowledge_chunks (tenant_id, source, content, category, embedding)
            values (${tenant}, ${source}, ${content}, ${category}, ${vecLiteral(content)}::vector)`,
      ),
    );
  }

  beforeAll(async () => {
    tenantC = randomUUID();
    tenantD = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantC, name: 'C' },
      { id: tenantD, name: 'D' },
    ]);
    for (const r of cRunbooks) await seedChunk(tenantC, r.source, r.content, 'runbook');
    await seedChunk(tenantC, cPostmortem.source, cPostmortem.content, 'postmortem');
    await seedChunk(tenantD, dRunbook.source, dRunbook.content, 'runbook');
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id in (${tenantC}, ${tenantD})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantC}, ${tenantD})`);
  });

  it('C2: returns the caller-tenant runbook chunks, cosine-ordered, limited to k, with additive fields', async () => {
    const results = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 2,
      scoreFloor: 0,
    });
    expect(results).toHaveLength(2); // limited to k out of the three runbooks
    expect(results[0]!.source).toBe('runbook/c-db.md'); // shares the query's seed term → ranks first
    expect(results.every((r) => cRunbookSources.includes(r.source))).toBe(true);
    for (const r of results) {
      expect(typeof r.score).toBe('number');
      expect(Number.isFinite(r.score)).toBe(true);
      expect(typeof r.occurrenceCount).toBe('number');
      expect(typeof r.verified).toBe('boolean');
    }
  });

  it('C3: isolates results bidirectionally and rejects a forged cross-tenant insert (RLS)', async () => {
    // tenantC must never surface tenantD's chunk, even though it shares the query's seed term.
    const asC = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
    });
    expect(asC.map((r) => r.source)).not.toContain(dRunbook.source);
    expect(asC.every((r) => cRunbookSources.includes(r.source))).toBe(true);

    // tenantD sees only its own single runbook.
    const asD = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantD, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
    });
    expect(asD).toHaveLength(1);
    expect(asD[0]!.source).toBe(dRunbook.source);

    // WITH CHECK write isolation: under tenantC's session, forge tenantD's id. app_user holds INSERT,
    // so the rejection is the tenant_isolation policy, not a privilege error (mirrors line ~129).
    const [embedding] = await fakeEmbedder.embed(['forged cross-tenant write attempt']);
    await expect(
      withTenant(app.db, tenantC, (tx) =>
        tx.insert(knowledgeChunks).values({
          tenantId: tenantD,
          source: 'runbook/forged-c.md',
          content: 'forged cross-tenant row',
          embedding: embedding!,
        }),
      ),
    ).rejects.toThrow();
  });

  it('C7: scoreFloor excludes below-floor matches; no floor (or 0) returns all up to k', async () => {
    // db scores ~1.0; net/disk score ~0.11. A 0.5 floor keeps only the database runbook.
    const floored = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
      scoreFloor: 0.5,
    });
    expect(floored.map((r) => r.source)).toEqual(['runbook/c-db.md']);
    expect(floored.every((r) => r.score >= 0.5)).toBe(true);

    // scoreFloor: 0 → all three runbooks returned (up to k), still cosine-ordered.
    const withZeroFloor = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
      scoreFloor: 0,
    });
    expect(withZeroFloor).toHaveLength(3);
    expect(withZeroFloor[0]!.source).toBe('runbook/c-db.md');

    // Omitted floor behaves like no floor.
    const noFloor = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
    });
    expect(noFloor).toHaveLength(3);
  });

  it('C8: the category discriminator filters to the requested category only', async () => {
    // The postmortem chunk shares the query's seed term (would rank unfiltered) yet must not
    // appear in a runbook-scoped search.
    const runbooks = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'runbook',
      query: DB_QUERY,
      k: 10,
    });
    expect(runbooks.map((r) => r.source)).not.toContain(cPostmortem.source);
    expect(runbooks.every((r) => cRunbookSources.includes(r.source))).toBe(true);

    // The postmortem category returns only the postmortem chunk, never the runbooks.
    const postmortems = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantC, {
      category: 'postmortem',
      query: DB_QUERY,
      k: 10,
    });
    expect(postmortems.map((r) => r.source)).toEqual([cPostmortem.source]);
  });
});

// upsertRunbook is the write path for the runbook category: create with defaults, or update an
// existing row by id (increment occurrence_count, dedupe-append provenance, refresh content /
// embedding / updated_at). RED now: upsertRunbook is not a function and the new columns are absent.
describe('upsertRunbook (create + idempotent update)', () => {
  let tenantE: string;

  async function readRow(tenant: string, id: string): Promise<Record<string, unknown> | undefined> {
    const rows = (await withTenant(app.db, tenant, (tx) =>
      tx.execute(
        sql`select category, occurrence_count, verified, source_incident_ids, content, updated_at,
                   (embedding is not null) as has_embedding
            from knowledge_chunks where id = ${id}`,
      ),
    )) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  async function countById(tenant: string, id: string): Promise<number> {
    const rows = (await withTenant(app.db, tenant, (tx) =>
      tx.execute(sql`select count(*)::int as n from knowledge_chunks where id = ${id}`),
    )) as unknown as Array<Record<string, unknown>>;
    return Number(rows[0]!.n);
  }

  beforeAll(async () => {
    tenantE = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantE, name: 'E' });
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id = ${tenantE}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantE}`);
  });

  it('C1: persists a categorized chunk with its embedding under the tenant RLS scope', async () => {
    const { id } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantE, {
      title: 'DB pool exhaustion',
      content: 'restart pgbouncer when the database pool is exhausted',
      sourceIncidentId: randomUUID(),
    });
    const row = await readRow(tenantE, id);
    expect(row).toBeDefined();
    expect(row!.category).toBe('runbook');
    expect(row!.has_embedding).toBe(true);
    // RLS scope: a different tenant session cannot read the row (deny-by-default).
    expect(await readRow(randomUUID(), id)).toBeUndefined();
  });

  it('C6: create (no id) defaults verified=false and occurrence_count=1', async () => {
    const { id } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantE, {
      title: null,
      content: 'a network partition across availability zones',
      sourceIncidentId: randomUUID(),
    });
    const row = await readRow(tenantE, id);
    expect(row!.verified).toBe(false);
    expect(Number(row!.occurrence_count)).toBe(1);
  });

  it('C4: existing id increments occurrence_count, dedupe-appends provenance, refreshes content/embedding/updated_at, no dup row', async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();

    // create (no id → server-generated; content shares the "database" seed term). The returned
    // id is then the update selector for the refine calls below — callers never dictate the PK.
    const { id } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantE, {
      title: 'RB',
      content: 'the database connection pool is exhausted',
      sourceIncidentId: s1,
    });
    const after1 = await readRow(tenantE, id);
    expect(Number(after1!.occurrence_count)).toBe(1);
    expect(after1!.source_incident_ids).toEqual([s1]);

    // update: new content (now a "network" chunk) + a new source incident.
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantE, {
      id,
      title: 'RB',
      content: 'a network partition across availability zones',
      sourceIncidentId: s2,
    });
    const after2 = await readRow(tenantE, id);
    expect(Number(after2!.occurrence_count)).toBe(2);
    expect(after2!.source_incident_ids).toEqual([s1, s2]);
    expect(after2!.content).toBe('a network partition across availability zones');
    expect(new Date(after2!.updated_at as string).getTime()).toBeGreaterThan(
      new Date(after1!.updated_at as string).getTime(),
    );

    // update with a DUPLICATE source incident (s1): occurrence_count is a recurrence tally tied to
    // the provenance array, so a re-link of an incident already present does NOT advance it;
    // provenance stays unchanged (no dup) while content still refreshes.
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantE, {
      id,
      title: 'RB',
      content: 'network partition remediation v2',
      sourceIncidentId: s1,
    });
    const after3 = await readRow(tenantE, id);
    expect(Number(after3!.occurrence_count)).toBe(2); // stays 2: the array did not grow
    expect(after3!.source_incident_ids).toEqual([s1, s2]); // s1 not duplicated
    expect(after3!.content).toBe('network partition remediation v2');

    // No duplicate row was ever created for this id.
    expect(await countById(tenantE, id)).toBe(1);

    // Embedding refreshed: the row started as a "database" chunk but a "network" query now finds it
    // above a 0.5 floor, proving the content was re-embedded on update.
    const netResults = await knowledgeRepo.searchChunks(app.db, fakeEmbedder, tenantE, {
      category: 'runbook',
      query: 'a network partition across availability zones',
      k: 10,
      scoreFloor: 0.5,
    });
    expect(netResults.some((r) => r.content === 'network partition remediation v2')).toBe(true);
  });
});

// --- additions -----------------------------------------------------------------
// occurrence_count is a RECURRENCE tally: it must advance ONLY when source_incident_ids actually
// grows (C8). A refine that re-links an incident already in the provenance array (double-click /
// redelivery) is a no-op and must NOT advance the count. RED now: the upsertRunbook
// increments occurrence_count unconditionally on every refine.
describe('upsertRunbook occurrence_count grows only with provenance', () => {
  let tenantF: string;

  async function occ(id: string): Promise<{ count: number; ids: unknown }> {
    const rows = (await withTenant(app.db, tenantF, (tx) =>
      tx.execute(
        sql`select occurrence_count, source_incident_ids from knowledge_chunks where id = ${id}`,
      ),
    )) as unknown as Array<Record<string, unknown>>;
    return { count: Number(rows[0]!.occurrence_count), ids: rows[0]!.source_incident_ids };
  }

  beforeAll(async () => {
    tenantF = randomUUID();
    await admin.db.insert(tenants).values({ id: tenantF, name: 'F' });
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id = ${tenantF}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantF}`);
  });

  it('a duplicate source incident does not advance occurrence_count; a distinct one does', async () => {
    const s1 = randomUUID();
    const s2 = randomUUID();
    const { id } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantF, {
      title: 'RB',
      content: 'the database connection pool is exhausted',
      sourceIncidentId: s1,
    });
    expect(await occ(id)).toEqual({ count: 1, ids: [s1] });

    // Refine with the SAME incident: provenance unchanged, so occurrence_count STAYS 1 (double-click).
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantF, {
      id,
      title: 'RB',
      content: 'restart pgbouncer when the pool is exhausted',
      sourceIncidentId: s1,
    });
    expect(await occ(id)).toEqual({ count: 1, ids: [s1] });

    // Refine with a DISTINCT incident of the recurring class: +1 and appended (C6/C8).
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantF, {
      id,
      title: 'RB',
      content: 'restart pgbouncer and kill long-running transactions',
      sourceIncidentId: s2,
    });
    expect(await occ(id)).toEqual({ count: 2, ids: [s1, s2] });
  });
});

// insertInvestigationNote writes an append-only 'investigation' chunk for a diagnostically-useful
// incident that produced no confirmed fix (C4); findChunkLinkingIncident reports whether ANY chunk
// already links an incident id (C7 idempotency), tenant-scoped (C9). RED now: neither symbol is a
// function on the repo (namespace access reads `undefined`) and there is no investigation writer.
describe('insertInvestigationNote + findChunkLinkingIncident', () => {
  let tenantG: string;
  let tenantH: string;

  async function readRow(tenant: string, id: string): Promise<Record<string, unknown> | undefined> {
    const rows = (await withTenant(app.db, tenant, (tx) =>
      tx.execute(
        sql`select category, verified, occurrence_count, source, source_incident_ids
            from knowledge_chunks where id = ${id}`,
      ),
    )) as unknown as Array<Record<string, unknown>>;
    return rows[0];
  }

  beforeAll(async () => {
    tenantG = randomUUID();
    tenantH = randomUUID();
    await admin.db.insert(tenants).values([
      { id: tenantG, name: 'G' },
      { id: tenantH, name: 'H' },
    ]);
  }, 30_000);

  afterAll(async () => {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id in (${tenantG}, ${tenantH})`);
    await admin.db.delete(tenants).where(sql`id in (${tenantG}, ${tenantH})`);
  });

  it('C4: persists an investigation note (category=investigation, verified=false) under tenant RLS', async () => {
    const incidentId = randomUUID();
    const { id } = await knowledgeRepo.insertInvestigationNote(app.db, fakeEmbedder, tenantG, {
      title: 'DB pool inconclusive',
      content: 'checked pool metrics; ruled out the deploy; open question: a connection leak?',
      sourceIncidentId: incidentId,
    });
    const row = await readRow(tenantG, id);
    expect(row).toBeDefined();
    expect(row!.category).toBe('investigation'); // NOT a runbook
    expect(row!.verified).toBe(false);
    expect(Number(row!.occurrence_count)).toBe(1);
    expect(row!.source_incident_ids).toEqual([incidentId]);
    // RLS scope: a different tenant session cannot read the note (deny-by-default).
    expect(await readRow(randomUUID(), id)).toBeUndefined();
  });

  it('C7: findChunkLinkingIncident is true once a chunk links the incident, false otherwise', async () => {
    const linked = randomUUID();
    const unlinked = randomUUID();
    // Before any chunk links it, the containment check is false (so the consumer proceeds to distil).
    expect(await knowledgeRepo.findChunkLinkingIncident(app.db, tenantG, linked)).toBe(false);
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantG, {
      title: 'RB',
      content: 'db pool remediation',
      sourceIncidentId: linked,
    });
    // Now a runbook links it → true (idempotency short-circuit fires on redelivery).
    expect(await knowledgeRepo.findChunkLinkingIncident(app.db, tenantG, linked)).toBe(true);
    // A different incident is still unlinked.
    expect(await knowledgeRepo.findChunkLinkingIncident(app.db, tenantG, unlinked)).toBe(false);
  });

  it('C9: findChunkLinkingIncident is tenant-scoped — tenant H never sees tenant G’s link (RLS)', async () => {
    const shared = randomUUID();
    await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantG, {
      title: 'RB',
      content: 'tenant G private remediation',
      sourceIncidentId: shared,
    });
    expect(await knowledgeRepo.findChunkLinkingIncident(app.db, tenantG, shared)).toBe(true);
    // Tenant H must not observe tenant G's link — RLS existence isolation, so it re-distils its own.
    expect(await knowledgeRepo.findChunkLinkingIncident(app.db, tenantH, shared)).toBe(false);
  });

  it('FIX 4: a cross-tenant refine-by-id cannot update or read another tenant’s runbook (RLS)', async () => {
    // Tenant G owns a runbook; tenant H attempts to refine it by that id. Under RLS the id is invisible
    // to H, so upsertRunbook takes the not-found path and inserts a NEW row for H (never honoring a
    // caller PK), and G's row is neither updated nor readable by H.
    const gIncident = randomUUID();
    const { id: idG } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantG, {
      title: 'G runbook',
      content: 'tenant G original remediation',
      sourceIncidentId: gIncident,
    });

    const { id: idFromH } = await knowledgeRepo.upsertRunbook(app.db, fakeEmbedder, tenantH, {
      id: idG, // forge G's id
      title: 'H attempt',
      content: 'tenant H overwrite attempt',
      sourceIncidentId: randomUUID(),
    });
    expect(idFromH).not.toBe(idG); // a fresh row for H, not G's

    // G's row is unchanged: same content, occurrence_count still 1 (H could neither update nor read it).
    const gRow = (await withTenant(app.db, tenantG, (tx) =>
      tx.execute(sql`select content, occurrence_count from knowledge_chunks where id = ${idG}`),
    )) as unknown as Array<Record<string, unknown>>;
    expect(gRow[0]!.content).toBe('tenant G original remediation');
    expect(Number(gRow[0]!.occurrence_count)).toBe(1);
  });
});
