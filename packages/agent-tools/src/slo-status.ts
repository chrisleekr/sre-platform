import * as z from 'zod';
import { sloStatusForService, type SloStatusView } from '@sre/slo';
import type { Db } from '@sre/db';
import type { ToolDefinition } from './types';

const fetchSloStatusInput = z.object({
  // Optional: defaults to the incident's primary service. The engine may pass a different service to
  // check the budget of an upstream or downstream it starts to suspect.
  service: z.string().min(1).optional(),
});

export type FetchSloStatusInput = z.infer<typeof fetchSloStatusInput>;

/**
 * Builds the tenant-scoped error-budget lookup tool.
 *
 * @remarks It reads the platform's own tables, so it binds for every tenant and empty is data, not absence.
 * @param deps - Database dependency used to read objectives and their latest burn events.
 */
export function makeFetchSloStatusTool(deps: {
  db: Db;
}): ToolDefinition<FetchSloStatusInput, SloStatusView[]> {
  return {
    name: 'fetch_slo_status',
    description:
      'Return the error-budget status for a service: per objective, the budget remaining, the current burn rate, and the projected time to exhaustion, from the latest evaluation. Defaults to the incident service; pass a service to re-scope. An objective not yet evaluated reports a null evaluation.',
    inputSchema: fetchSloStatusInput,
    async handler(ctx, input) {
      const data = await sloStatusForService(deps.db, ctx.tenantId, input.service ?? ctx.service);
      return { available: true, data };
    },
  };
}
