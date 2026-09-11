// Tenant-scoped runbook/knowledge corpus for pgvector RAG. Each row is one embedded
// chunk; search_runbooks ranks them by cosine distance. Under RLS. The `vector` extension itself is
// still created as raw SQL in migrate.ts (drizzle-kit does not emit CREATE EXTENSION), before the
// migration that declares this table's vector column runs.
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  vector,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { tenantIsolation } from './rls';
import { EMBED_DIM } from '../embedder';

export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    title: text('title'),
    content: text('content').notNull(),
    // Retrieval-corpus discriminator. 'runbook' preserves the search_runbooks path; other
    // categories (e.g. postmortem) share the table but are filtered by searchChunks.
    category: text('category').notNull().default('runbook'),
    // Runbook idempotency: upsertRunbook bumps this on each merge into an existing runbook.
    occurrenceCount: integer('occurrence_count').notNull().default(1),
    // Provenance: incident ids that contributed to this chunk, dedupe-appended by upsertRunbook.
    sourceIncidentIds: jsonb('source_incident_ids').notNull().default([]),
    // Human-reviewed flag; auto-derived runbooks start unverified.
    verified: boolean('verified').notNull().default(false),
    embedding: vector('embedding', { dimensions: EMBED_DIM }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // HNSW over the cosine opclass, matching the `<=>` operator searchChunks ranks with. An L2/btree
    // index here would rank by the wrong distance.
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    tenantIsolation(),
  ],
);
