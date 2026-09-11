import { searchIncidentEvidence, type Db } from '@sre/db';
import * as z from 'zod';
import type { ToolDefinition } from './types';

const inputSchema = z.object({
  query: z.string().trim().min(2).max(200),
  limit: z.number().int().min(1).max(20).default(10),
});

type SearchIncidentEvidenceInput = z.infer<typeof inputSchema>;

/**
 * Builds the search tool for durable evidence already collected for an incident.
 *
 * @param deps - Database dependency used to search tenant-scoped evidence.
 */
export function makeSearchIncidentEvidenceTool(deps: {
  db: Db;
}): ToolDefinition<
  SearchIncidentEvidenceInput,
  Awaited<ReturnType<typeof searchIncidentEvidence>>
> {
  return {
    name: 'search_incident_evidence',
    description:
      'Search prior audited checks from this incident by metric, resource, repository, job, or other subject text. Whitespace-separated terms match independently; use a specific identifier to narrow results. Results include original evidence IDs and timestamps. Read matching originals with read_recorded_evidence. No matches means only that this search found nothing, not that evidence does not exist. Reuse matching facts before repeating provider calls.',
    inputSchema,
    async handler(ctx, input) {
      return {
        available: true,
        data: await searchIncidentEvidence(
          deps.db,
          ctx.tenantId,
          ctx.incidentId,
          input.query,
          input.limit,
        ),
      };
    },
  };
}
