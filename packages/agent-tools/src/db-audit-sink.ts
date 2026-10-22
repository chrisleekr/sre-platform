import { recordToolCall, type Db } from '@sre/db';
import type { ToolAuditSink } from './types';

export interface DbAuditSinkDeps {
  db: Db;
}

/**
 * Builds a Postgres-backed sink for investigator tool audits.
 *
 * @param deps - Database dependency used for tenant-scoped audit writes.
 */
export function makeDbAuditSink(deps: DbAuditSinkDeps): ToolAuditSink {
  return {
    async record(entry) {
      return recordToolCall(deps.db, entry.tenantId, {
        incidentId: entry.incidentId,
        tool: entry.tool,
        input: entry.input,
        latencyMs: entry.latencyMs,
        outcome: entry.outcome,
        output: entry.output,
      });
    },
  };
}
