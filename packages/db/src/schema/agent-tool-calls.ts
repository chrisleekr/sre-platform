// One row per triage tool run: the durable audit trail behind the engine-agnostic ToolAuditSink
//Under RLS. `input` is the tool input AFTER redaction — the persisting sink
// scrubs sensitive values before insert, since input can carry credentials (CWE-532).
import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  timestamp,
  foreignKey,
  index,
} from 'drizzle-orm/pg-core';
import { tenants } from './control-plane';
import { incidents } from './incidents';
import { tenantIsolation } from './rls';

export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    incidentId: uuid('incident_id').notNull(),
    tool: text('tool').notNull(),
    input: jsonb('input').notNull(),
    latencyMs: integer('latency_ms').notNull(),
    // data | error
    outcome: text('outcome').notNull(),
    // The tool output AFTER redaction (the working-memory evidence store). Nullable: only
    // `data` runs carry an output; an `error` run has none. EVERY writer must redact before insert,
    // so this column is never a raw-secret sink (CWE-532). Two writers exist: `runTool` (dispatch)
    // redacts once and feeds the audit sink; `seedFirstPass` (worker.ts) redacts its own
    // fetchTriageContext output. A new direct `recordToolCall` caller MUST redact too.
    output: jsonb('output'),
    // Millisecond precision makes the public (created_at, id) evidence cursor round-trip through JS Date
    // without skipping rows that differed only below the precision JavaScript can represent.
    createdAt: timestamp('created_at', { withTimezone: true, precision: 3 }).defaultNow().notNull(),
  },
  (t) => [
    // Tenant-scoped incident FK: RI checks bypass RLS, so a plain incident_id FK would let one
    // tenant reference/probe another tenant's incident. [pattern]
    foreignKey({
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incidents.tenantId, incidents.id],
      name: 'agent_tool_calls_incident_fk',
    }),
    index('agent_tool_calls_incident_created_id_idx').on(
      t.incidentId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    index('agent_tool_calls_tenant_created_id_idx').on(t.tenantId, t.createdAt.desc(), t.id.desc()),
    tenantIsolation(),
  ],
);
