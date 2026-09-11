import type { Db } from '@sre/db';
import { computeBlastRadius, type BlastRadius } from '@sre/topology';
import * as z from 'zod';
import type { ToolDefinition } from './types';

const fetchBlastRadiusInput = z.object({
  // Optional: defaults to the incident's primary service. The engine may pass a different service to
  // re-scope onto a dependency it starts to suspect.
  service: z.string().min(1).optional(),
});

export type FetchBlastRadiusInput = z.infer<typeof fetchBlastRadiusInput>;

/**
 * Builds the tenant-scoped topology impact tool used during investigation.
 *
 * @param deps - Database dependency used to traverse the tenant topology graph.
 */
export function makeFetchBlastRadiusTool(deps: {
  db: Db;
}): ToolDefinition<FetchBlastRadiusInput, BlastRadius> {
  return {
    name: 'fetch_blast_radius',
    description:
      "Return the blast radius of a failing service: affected callers tiered as direct (hard down), indirect (degraded via an async edge), or insulated (circuit-breaker protected), plus the service's own direct dependencies as candidate root causes. Defaults to the incident service; pass a service to re-scope.",
    inputSchema: fetchBlastRadiusInput,
    async handler(ctx, input) {
      const data = await computeBlastRadius(deps.db, ctx.tenantId, input.service ?? ctx.service);
      return { available: true, data };
    },
  };
}
