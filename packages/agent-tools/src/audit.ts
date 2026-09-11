import type { ToolAuditRecord, ToolAuditSink } from './types';
import { randomUUID } from 'node:crypto';

export interface InMemoryAuditSink extends ToolAuditSink {
  readonly records: ToolAuditRecord[];
}

/** An audit sink that retains records in memory, for tests and local dev. */
export function makeInMemoryAuditSink(): InMemoryAuditSink {
  const records: ToolAuditRecord[] = [];
  return {
    records,
    async record(entry) {
      records.push(entry);
      return randomUUID();
    },
  };
}
