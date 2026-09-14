import * as z from 'zod';
import type { Db } from '@sre/db';
import type { TopologyEndpointEvidence } from '@sre/contracts';
import { readTopologyEndpointEvidence } from '@sre/topology';
import type { ToolDefinition } from './types';

const input = z.object({ subjectKey: z.string().min(1).max(8192) });

/** Read existing audited endpoint probes without issuing new network operations.
 * @param deps - Tenant-scoped discovery and evidence database.
 */
export function makeReadTopologyEndpointTool(deps: {
  db: Db;
}): ToolDefinition<z.infer<typeof input>, TopologyEndpointEvidence> {
  return {
    name: 'read_topology_endpoint_evidence',
    description:
      'Read recent tenant-audited network probe evidence for an exact discovered HTTP endpoint. Pass its identityRef as subjectKey. Shows DNS, TCP, TLS and HTTP observations with freshness and original incident evidence references. This does not issue a network request or prove service ownership, dependency identity or complete availability.',
    inputSchema: input,
    async handler(ctx, value) {
      return {
        available: true,
        data: await readTopologyEndpointEvidence(deps.db, ctx.tenantId, value.subjectKey),
      };
    },
  };
}
