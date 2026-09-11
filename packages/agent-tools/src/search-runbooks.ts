import type { Db, Embedder } from '@sre/db';
import { searchChunks } from '@sre/db';
import * as z from 'zod';
import type { ToolDefinition } from './types';

const searchRunbooksInput = z.object({
  query: z.string().min(1),
  k: z.number().int().positive().default(5),
});

export type SearchRunbooksInput = z.infer<typeof searchRunbooksInput>;

/**
 * A runbook surfaced to the engine. Carries institutional confidence
 * (occurrenceCount + verified) but NOT the raw cosine score or createdAt: a similarity number must
 * not read as certainty, and ordering already encodes relevance.
 */
export interface RunbookHit {
  source: string;
  title: string | null;
  content: string;
  occurrenceCount: number;
  verified: boolean;
}

/**
 * Builds semantic search over the tenant's runbook knowledge corpus.
 *
 * @param deps - Database and embedding dependencies used for tenant-scoped retrieval.
 */
export function makeSearchRunbooksTool(deps: {
  embedder: Embedder;
  db: Db;
}): ToolDefinition<SearchRunbooksInput, RunbookHit[]> {
  return {
    name: 'search_runbooks',
    description:
      'Semantic search over the tenant runbooks and diagnostic investigation notes distilled from past incidents; returns candidate ' +
      'runbooks ordered by relevance. occurrence_count and verified are institutional confidence (how ' +
      'often this recurred, whether a human reviewed it) — NOT a measure of correctness for THIS ' +
      'incident. Treat each as an advisory candidate: verify it matches the current evidence before applying.',
    inputSchema: searchRunbooksInput,
    async handler(ctx, input) {
      const rows = await searchChunks(deps.db, deps.embedder, ctx.tenantId, {
        category: ['runbook', 'investigation'],
        query: input.query,
        k: input.k,
      });
      // Drop the raw score and createdAt; surface only source + content + institutional confidence.
      const data: RunbookHit[] = rows.map((r) => ({
        source: r.source,
        title: r.title,
        content: r.content,
        occurrenceCount: r.occurrenceCount,
        verified: r.verified,
      }));
      return { available: true, data };
    },
  };
}
