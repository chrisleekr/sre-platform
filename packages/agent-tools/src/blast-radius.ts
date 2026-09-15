import type { Db } from '@sre/db';
import { computeBlastRadius, computeIncidentBlastRadius, type BlastRadius } from '@sre/topology';
import * as z from 'zod';
import type { ToolDefinition } from './types';
import { topologyReferences, type TopologyToolEvidence } from './topology-references';

const fetchBlastRadiusInput = z
  .object({
    // Optional: defaults to the incident's primary service. The engine may pass a different service to
    // re-scope onto a dependency it starts to suspect.
    service: z.string().min(1).optional(),
    environment: z.string().min(1).optional(),
    subjectKey: z.string().min(1).optional(),
  })
  .refine((input) => !input.environment || Boolean(input.service || input.subjectKey), {
    message: 'environment requires service or subjectKey',
    path: ['environment'],
  });

export type FetchBlastRadiusInput = z.infer<typeof fetchBlastRadiusInput>;

/**
 * Builds the tenant-scoped topology impact tool used during investigation.
 *
 * @param deps - Database dependency used to traverse the tenant topology graph.
 */
export function makeFetchBlastRadiusTool(deps: {
  db: Db;
}): ToolDefinition<FetchBlastRadiusInput, TopologyToolEvidence<BlastRadius>> {
  return {
    name: 'fetch_blast_radius',
    description:
      'Return potential caller exposure from discovered calls and catalog declarations, plus dependencies to investigate. This does not prove outages, delayed impact or circuit-breaker protection. Unknown call semantics and ambiguous service identities are explicit. Defaults to the incident service; To re-scope, supply service with environment, or pass a subjectRef returned by topology resolution as subjectKey. Environment alone is not accepted.',
    inputSchema: fetchBlastRadiusInput,
    async handler(ctx, input) {
      const data =
        !input.service && !input.subjectKey && !input.environment
          ? await computeIncidentBlastRadius(deps.db, ctx.tenantId, ctx.incidentId, ctx.service)
          : await computeBlastRadius(deps.db, ctx.tenantId, input.service ?? ctx.service, {
              environment: input.environment,
              subjectKey: input.subjectKey,
            });
      return { available: true, data: topologyReferences(data) };
    },
  };
}
