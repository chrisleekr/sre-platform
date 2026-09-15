import * as z from 'zod';
import type { Db } from '@sre/db';
import type { TopologyRuntimeEvidence } from '@sre/contracts';
import { readTopologyRuntime, type TopologyRuntimeReader } from '@sre/topology';
import type { ToolDefinition } from './types';
import { topologyReferences, type TopologyToolEvidence } from './topology-references';

const input = z.object({ subjectKey: z.string().min(1).max(8192) });

/** Expose identity-matched runtime observations without treating samples as service recovery.
 * @param deps - Tenant database and generation-aware platform snapshot reader.
 */
export function makeReadTopologyRuntimeTool(deps: {
  db: Db;
  read: TopologyRuntimeReader;
}): ToolDefinition<z.infer<typeof input>, TopologyToolEvidence<TopologyRuntimeEvidence>> {
  return {
    name: 'read_topology_runtime',
    description:
      'Read current runtime observations. Pass a topology subjectRef or subject identityRef returned by resolve_entity_context or fetch_blast_radius as subjectKey. Partial evidence and stale resource state are explicit. Healthy observed resources do not establish complete service coverage or recovery.',
    inputSchema: input,
    async handler(ctx, value) {
      return {
        available: true,
        data: topologyReferences(
          await readTopologyRuntime(deps.db, ctx.tenantId, { key: value.subjectKey }, deps.read),
        ),
      };
    },
  };
}
