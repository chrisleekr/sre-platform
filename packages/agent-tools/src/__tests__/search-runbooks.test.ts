// Live-infra test (mirrors connector-provider.test.ts): seeds chunks as app_user under RLS (only the
// tenant row is inserted as admin) and runs the tool's handler through runTool as app_user. A fake
// deterministic Embedder (same scheme as knowledge-repo.test.ts) makes ranking predictable offline.
// Proves search_runbooks exposes its stable name, returns ranked data, and records exactly one audit entry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  makeDb,
  tenants,
  knowledgeChunks,
  insertKnowledgeChunks,
  EMBED_DIM,
  type DbHandle,
  type Embedder,
} from '@sre/db';
import { makeSearchRunbooksTool } from '../search-runbooks';
import { runTool } from '../dispatch';
import { makeInMemoryAuditSink } from '../audit';
import type { ToolContext } from '../types';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const SEED_TERMS = ['database', 'network'] as const;
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
  content: 'Restart pgbouncer when the database connection pool is exhausted.',
};
const networkChunk = {
  source: 'runbook/network-partition.md',
  content: 'Check the network ACLs during a cross-AZ network partition.',
};
const DB_QUERY = 'the database connection pool is exhausted';

let app: DbHandle;
let admin: DbHandle;
let tenantId: string;
// A real tenant seeded with NO knowledge chunks. RLS scopes results to ctx.tenantId, so this is a
// genuinely empty runbook corpus rather than a query that merely matches nothing.
let emptyTenantId: string;
let tool: ReturnType<typeof makeSearchRunbooksTool>;

function makeCtx(audit: ToolContext['audit'], tenant = tenantId): ToolContext {
  return {
    tenantId: tenant,
    incidentId: 'incident-1',
    service: 'api',
    // search_runbooks reads the platform store, not connectors; resolver is never called.
    resolveConnectors: () => Promise.resolve([]),
    audit,
  };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  tenantId = randomUUID();
  emptyTenantId = randomUUID();
  await admin.db.insert(tenants).values({ id: tenantId, name: 'A' });
  await admin.db.insert(tenants).values({ id: emptyTenantId, name: 'empty' });
  await insertKnowledgeChunks(app.db, fakeEmbedder, tenantId, [dbChunk, networkChunk]);
  tool = makeSearchRunbooksTool({ embedder: fakeEmbedder, db: app.db });
}, 30_000);

afterAll(async () => {
  if (admin) {
    await admin.db.delete(knowledgeChunks).where(sql`tenant_id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${tenantId}`);
    await admin.db.delete(tenants).where(sql`id = ${emptyTenantId}`);
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeSearchRunbooksTool', () => {
  it('exposes its stable tool name', () => {
    expect(tool.name).toBe('search_runbooks');
  });

  it('returns the most-similar runbook chunk ranked first as available data', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit), { query: DB_QUERY, k: 3 });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data[0]!.source).toBe(dbChunk.source);
    // the on-demand tool surfaces confidence (occurrence_count + verified) to the
    // engine but NEVER the raw cosine score or createdAt — a similarity number must not read as
    // certainty. RED until the tool trims score/createdAt from the returned rows.
    const top = result.data[0]! as unknown as Record<string, unknown>;
    expect('score' in top).toBe(false);
    expect('createdAt' in top).toBe(false);
    expect(typeof top.occurrenceCount).toBe('number');
    expect(typeof top.verified).toBe('boolean');
  });

  it('records exactly one audit entry with outcome data', async () => {
    const audit = makeInMemoryAuditSink();
    await runTool(tool, makeCtx(audit), { query: DB_QUERY });
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
    expect(audit.records[0]!.tool).toBe('search_runbooks');
  });

  // Characterization lock: empty is DATA, not unavailability. This tool reads the platform's own
  // knowledge_chunks store, so it always has data to return and is never gated on an enabled
  // connector — an empty corpus must stay `available: true` with an empty list, never an
  // unavailable path.
  it('returns available:true with an empty list on an empty store', async () => {
    const audit = makeInMemoryAuditSink();
    const result = await runTool(tool, makeCtx(audit, emptyTenantId), { query: DB_QUERY, k: 3 });
    expect(result.available).toBe(true);
    if (!result.available) throw new Error('expected available data');
    expect(result.data).toEqual([]);
    // Empty still audits as a data outcome, not an error.
    expect(audit.records).toHaveLength(1);
    expect(audit.records[0]!.outcome).toBe('data');
  });
});
