import { recordToolCall, type Db } from '@sre/db';
import { redactInput } from './redact';
import type { ToolAuditSink } from './types';

export interface DbAuditSinkDeps {
  db: Db;
}

/**
 * Builds a Postgres-backed sink for redacted investigator tool audits.
 *
 * @param deps - Database dependency used for tenant-scoped audit writes.
 */
export function makeDbAuditSink(deps: DbAuditSinkDeps): ToolAuditSink {
  return {
    async record(entry) {
      return recordToolCall(deps.db, entry.tenantId, {
        incidentId: entry.incidentId,
        tool: entry.tool,
        input: redactInput(entry.input),
        latencyMs: entry.latencyMs,
        outcome: entry.outcome,
        // Already redacted by `runTool` at dispatch, this sink's only feeder; persist verbatim (no
        // double-redact). The input above is NOT pre-redacted, hence the redactInput there.
        output: entry.output,
      });
    },
  };
}
