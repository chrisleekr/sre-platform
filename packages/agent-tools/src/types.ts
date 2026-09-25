import type { ZodType } from 'zod';
import type { IDataSourceConnector } from '@sre/connectors';

/**
 * The outcome of running a triage tool: data, or an error. A tool the tenant cannot serve is not
 * bound at all, so absence from the tool surface — not a result value — expresses it. An
 * empty store is therefore DATA (an empty list, an unmapped blast radius), never a
 * distinct "nothing yet" outcome. `error` means the handler/connector threw and `runTool` caught it.
 * Emptiness is a first-class value, never an exception. No error detail is carried here — raw
 * failure text could leak credentials to the engine (CWE-209). Both outcomes carry the durable audit
 * row id, returned only after persistence completes.
 */
export type ToolResult<O> =
  | { available: true; data: O; evidenceId: string }
  | { available: false; reason: 'error'; evidenceId: string };

/** Result produced by a tool handler before the dispatcher persists its audit row. */
export type ToolHandlerResult<O> =
  { available: true; data: O } | { available: false; reason: 'error' };

export type ToolOutcome = 'data' | 'error';

/**
 * One record per tool run. `input` is the raw, validated tool input: a persisting sink
 * MUST redact it before storage, since input can carry sensitive values (CWE-532).
 */
export interface ToolAuditRecord {
  tool: string;
  tenantId: string;
  incidentId: string;
  input: unknown;
  latencyMs: number;
  outcome: ToolOutcome;
  /**
   * The tool output AFTER redaction, present only for a `data` run (working memory). `runTool`
   * redacts once and passes the SAME value here and to the model; the sink persists it verbatim.
   * Absent for an `error` run (no data).
   */
  output?: unknown;
}

/**
 * Sink for one audit entry per tool run. Resolves to the durable row id only after persistence.
 */
export interface ToolAuditSink {
  record(entry: ToolAuditRecord): Promise<string>;
}

export interface ToolContext {
  tenantId: string;
  incidentId: string;
  /** The incident's primary service; tools may use it as the default subject of a query. */
  service: string;
  /**
   * Resolves the tenant's enabled connectors (the injection point for tests and the DB
   * provider). The worker resolves these once per run to build the per-tenant connector-tool
   * surface; a platform tool that reads its own store ignores them.
   */
  resolveConnectors(): Promise<IDataSourceConnector[]>;
  audit: ToolAuditSink;
  /**
   * The run's cancellation, for example its job deadline. Handlers pass it to provider requests,
   * and `runTool` rethrows its reason rather than recording an aborted call as a tool error.
   */
  signal?: AbortSignal;
}

export interface ToolDefinition<I, O> {
  name: string;
  description: string;
  inputSchema: ZodType<I>;
  handler(ctx: ToolContext, input: I): Promise<ToolHandlerResult<O>>;
}
