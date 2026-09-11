import { expect, test, vi } from 'vitest';

import { makeClaudeEngine } from '../claude';
import { createFixture } from './claude.fixture';

const __fixture = createFixture();

test('focused Claude reassessment uses durable evidence and the four-turn ceiling', async () => {
  const create = vi.fn().mockResolvedValueOnce(
    __fixture.toolUseTurn('focused-report', 'report_findings', {
      outcome: 'conclusive',
      summary: 'The prior diagnosis still holds.',
      confidence: 80,
      rankedHypotheses: [],
      unknowns: [],
    }),
  );
  const engine = makeClaudeEngine(
    { apiKey: 'k', model: 'claude-test', maxTurns: 12 },
    { messages: { create } },
  );
  const { runtime } = __fixture.makeRuntime();
  const metadata = vi.fn();
  runtime.onExecutionMetadata = metadata;

  await engine.investigate(
    {
      ...__fixture.input,
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
    runtime,
  );

  const request = create.mock.calls[0]![0] as {
    system: string;
    messages: Array<{ content: unknown }>;
  };
  expect(request.system).toContain('focused reassessment');
  expect(request.system).not.toContain('1. Blast radius');
  expect(JSON.stringify(request.messages)).toContain('Pool saturation confirmed.');
  expect(JSON.stringify(request.messages)).toContain('Severity changed to critical.');
  expect(JSON.stringify(request.messages).match(/Evidence already gathered/g)).toHaveLength(1);
  expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ turnBudget: 4 }));
});
