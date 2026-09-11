import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ToolContext } from '@sre/agent-tools';
import { expect, test, vi } from 'vitest';

import { makeAgentSdkEngine } from '../agent-sdk';
import { createFixture } from './agent-sdk.fixture';

const __fixture = createFixture();

test('focused Agent SDK reassessment uses durable evidence and the four-turn ceiling', async () => {
  let captured: { prompt?: unknown; options?: Options } | undefined;
  const report = {
    outcome: 'conclusive',
    summary: 'The prior diagnosis still holds.',
    confidence: 80,
    rankedHypotheses: [],
    unknowns: [],
  };
  const engine = makeAgentSdkEngine({
    runtime: { ...__fixture.runtime, maxTurns: 12 },
    credential: 'provider-key',
    query: __fixture.mcpQuery(
      async (client) => {
        await client.callTool({ name: 'report_findings', arguments: report });
      },
      [],
      (params) => {
        captured = params;
      },
    ),
  });
  const metadata = vi.fn();

  await engine.investigate(
    {
      incident: {
        id: 'incident-focused',
        tenantId: 'tenant-focused',
        service: 'checkout',
        severity: 'sev2',
        fingerprint: 'focused-fingerprint',
        alertSource: 'alertmanager',
      },
      mode: 'focused',
      alert: {
        priorAssessment: { trustedRunId: 'prior-run', summary: 'Pool saturation confirmed.' },
        materialDeltas: [{ summary: 'Severity changed to critical.' }],
      },
      evidence: [
        {
          id: 'evidence-focused',
          tool: 'query_metrics',
          input: { query: 'errors' },
          output: { value: 12 },
          createdAt: '2026-08-31T01:00:00.000Z',
        },
      ],
    },
    {
      tools: [],
      ctx: {
        tenantId: 'tenant-focused',
        incidentId: 'incident-focused',
        service: 'checkout',
        resolveConnectors: async () => [],
        audit: { record: async () => 'evidence-focused' },
      } as ToolContext,
      signal: new AbortController().signal,
      onStep: vi.fn(async () => undefined),
      onExecutionMetadata: metadata,
    },
  );

  expect(captured?.options?.systemPrompt).toContain('focused reassessment');
  expect(captured?.options?.maxTurns).toBe(4);
  expect(String(captured?.prompt)).toContain('Pool saturation confirmed.');
  expect(String(captured?.prompt)).toContain('Severity changed to critical.');
  expect(String(captured?.prompt).match(/Evidence already gathered/g)).toHaveLength(1);
  expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ turnBudget: 4 }));
});
