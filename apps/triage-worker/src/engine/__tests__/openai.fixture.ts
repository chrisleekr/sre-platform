import { makeInMemoryAuditSink, type ToolContext } from '@sre/agent-tools';
import { vi } from 'vitest';
import * as z from 'zod';
import type { TranscriptKind, TriageInput, TriageRuntime } from '../types';

export function createFixture() {
  const input: TriageInput = {
    incident: {
      id: 'inc-9',
      tenantId: 't',
      service: 'api',
      severity: 'sev1',
      fingerprint: 'fp',
      alertSource: 'github',
    },
  };

  /** A runtime whose onStep collects steps and whose audit sink exposes dispatched calls. */
  function makeRuntime(tools: TriageRuntime['tools'] = []) {
    const steps: { kind: TranscriptKind; content: string }[] = [];
    const audit = makeInMemoryAuditSink();
    const ctx: ToolContext = {
      tenantId: 't',
      incidentId: 'inc-9',
      service: 'api',
      resolveConnectors: async () => [],
      audit,
    };
    const runtime: TriageRuntime = {
      ctx,
      tools,
      signal: new AbortController().signal,
      async onStep(kind, content) {
        steps.push({ kind, content });
      },
    };
    return { steps, runtime, audit };
  }

  const probeInputSchema = z.object({ service: z.string(), windowMinutes: z.number() });

  function probeTool(name: string, data: unknown) {
    const handler = vi.fn(async () => ({ available: true as const, data }));
    const tool: TriageRuntime['tools'][number] = {
      name,
      description: `${name} probe`,
      inputSchema: probeInputSchema,
      handler,
    };
    return { handler, tool };
  }

  function toolCall(id: string, name: string, args: string) {
    return { id, type: 'function', function: { name, arguments: args } };
  }

  function toolCallTurn(...calls: ReturnType<typeof toolCall>[]) {
    return {
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { role: 'assistant', content: null, tool_calls: calls },
        },
      ],
    };
  }

  return {
    input,
    makeRuntime,
    probeInputSchema,
    probeTool,
    toolCall,
    toolCallTurn,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
