import { expect, test, vi } from 'vitest';

import { makeOpenAIEngine } from '../openai';

import { createFixture } from './openai.fixture';

const __fixture = createFixture();

test('focused reassessment uses the delta system contract and four-turn ceiling', async () => {
  const create = vi.fn().mockResolvedValueOnce(
    __fixture.toolCallTurn(
      __fixture.toolCall(
        'focused-report',
        'report_findings',
        JSON.stringify({
          outcome: 'conclusive',
          summary: 'The prior diagnosis still holds.',
          confidence: 80,
          rankedHypotheses: [],
        }),
      ),
    ),
  );
  const engine = makeOpenAIEngine(
    { apiKey: 'k', model: 'gpt-x', maxTurns: 12 },
    { chat: { completions: { create } } },
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
    messages: Array<{ role: string; content: string }>;
    tools: Array<{ function: { name: string } }>;
  };
  expect(request.messages[0]?.content).toContain('focused reassessment');
  expect(request.messages[0]?.content).not.toContain('1. Blast radius');
  expect(request.messages[1]?.content).toContain('Pool saturation confirmed.');
  expect(request.messages[1]?.content).toContain('Severity changed to critical.');
  expect(request.messages[1]?.content.match(/Evidence already gathered/g)).toHaveLength(1);
  expect(request.tools.map((tool) => tool.function.name)).toEqual(['report_findings']);
  expect(metadata).toHaveBeenCalledWith(expect.objectContaining({ turnBudget: 4 }));
});
