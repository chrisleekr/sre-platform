import { makeInMemoryAuditSink, type ToolContext, type ToolDefinition } from '@sre/agent-tools';
import * as z from 'zod';
import type { TranscriptKind, TriageInput, TriageRuntime } from '../types';

export function createFixture() {
  // Inline tool doubles standing in for the tenant's bound tools. The loop contract (bind, dispatch,
  // audit, empty-result handling) is what these engine tests exercise, decoupled from any shipped tool.
  // The doubles serve an EMPTY store: emptiness is data, so they return `{ available: true, data: [] }`.
  const signalInputSchema = z.object({ service: z.string(), windowMinutes: z.number() });

  function emptyDataTool(
    name: string,
  ): ToolDefinition<{ service: string; windowMinutes: number }, unknown[]> {
    return {
      name,
      description: `${name} probe`,
      inputSchema: signalInputSchema,
      handler: async () => ({ available: true, data: [] }),
    };
  }

  const input: TriageInput = {
    incident: {
      id: 'inc-1',
      tenantId: 't',
      service: 'checkout',
      severity: 'sev2',
      fingerprint: 'fp',
      alertSource: 'datadog',
    },
    alert: { x: 1 },
  };

  /** A tenant whose bound tools have empty stores: every run returns empty data, still audited. */
  function makeRuntime() {
    const steps: { kind: TranscriptKind; content: string }[] = [];
    const audit = makeInMemoryAuditSink();
    const ctx: ToolContext = {
      tenantId: 't',
      incidentId: 'inc-1',
      service: 'checkout',
      resolveConnectors: async () => [],
      audit,
    };
    const runtime: TriageRuntime = {
      ctx,
      tools: [emptyDataTool('datadog_query_metrics'), emptyDataTool('datadog_search')],
      signal: new AbortController().signal,
      async onStep(kind, content) {
        steps.push({ kind, content });
      },
    };
    return { steps, runtime, audit };
  }

  /** One scripted `tool_use` turn for the injectable Anthropic stub. */
  function toolUseTurn(id: string, name: string, toolInput: unknown) {
    return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: toolInput }] };
  }

  /** Flatten the structured `tool_result` blocks out of a request's messages. */
  function toolResultsIn(req: unknown): Array<{
    type: string;
    tool_use_id?: string;
    content?: string;
    is_error?: boolean;
  }> {
    const messages = (req as { messages: Array<{ content: unknown }> }).messages;
    return messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  }

  // APIError.generate returns an APIConnectionError (status undefined) when headers are falsy, so a
  // status-specific subclass needs a real Headers object — matching what the SDK builds from a response.
  const H = (): Headers => new Headers();

  return {
    signalInputSchema,
    emptyDataTool,
    input,
    makeRuntime,
    toolUseTurn,
    toolResultsIn,
    H,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
