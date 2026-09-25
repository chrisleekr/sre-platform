import { describe, expect, test, vi } from 'vitest';

import OpenAI from 'openai';

import { makeOpenAIEngine, openaiText, type OpenAILike } from '../openai';

import { ProviderRateLimitError, ProviderUnavailableError } from '../types';

import type { ResumeInput } from '../types';

import { createFixture } from './openai.fixture';

const __fixture = createFixture();

test('openaiText reads the first choice content', () => {
  expect(openaiText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi');
  expect(openaiText({})).toBe('');
});

describe('makeOpenAIEngine', () => {
  test('recovery binds only report_recovery and returns its evidence proposal', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      __fixture.toolCallTurn(
        __fixture.toolCall(
          'recovery',
          'report_recovery',
          JSON.stringify({
            summary: 'Current error rate is back below threshold.',
            recovered: true,
            evidence: [{ name: 'Error rate', before: 'Above threshold', now: 'Below 1%' }],
            evidenceIds: ['11111111-1111-4111-8111-111111111111'],
            unknowns: [],
            questions: [],
            nextStep: null,
          }),
        ),
      ),
    );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.verifyRecovery(
      { ...__fixture.input, prior: [], signalSummary: '[RESOLVED] ApiHighErrorRate' },
      runtime,
    );

    const names = (
      create.mock.calls[0]![0] as { tools: Array<{ function: { name: string } }> }
    ).tools.map((tool) => tool.function.name);
    expect(names).toEqual(['report_recovery']);
    expect(result).toMatchObject({
      disposition: 'recovery',
      recovery: {
        recovered: true,
        evidence: [{ name: 'Error rate', before: 'Above threshold', now: 'Below 1%' }],
      },
    });
  });

  test('resume exposes report_recovery when every provider signal is cleared', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      __fixture.toolCallTurn(
        __fixture.toolCall(
          'resume-recovery',
          'report_recovery',
          JSON.stringify({
            outcome: 'recovered',
            summary: 'Checkout is healthy again.',
            evidence: [{ name: 'Error rate', before: 'Above threshold', now: 'Below 1%' }],
            evidenceIds: ['11111111-1111-4111-8111-111111111111'],
            unknowns: [],
            questions: [],
            nextStep: null,
          }),
        ),
      ),
    );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.resume(
      {
        ...__fixture.input,
        humanMessage: 'Is this recovered now?',
        prior: [],
        recoveryContext: {
          attempt: 1,
          maxChecks: 3,
          signalSummary: '[RESOLVED] CheckoutHighErrorRate',
        },
      },
      runtime,
    );

    const names = (
      create.mock.calls[0]![0] as { tools: Array<{ function: { name: string } }> }
    ).tools.map((tool) => tool.function.name);
    expect(names).toContain('report_recovery');
    expect(result).toMatchObject({
      disposition: 'recovery',
      recovery: { outcome: 'recovered', recovered: true },
    });
  });

  test('investigate returns an inconclusive outcome when the model stops without a terminal call', async () => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: '{"summary":"bad deploy","confidence":60}' } }],
          })),
        },
      },
    };
    const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
    const { steps, runtime } = __fixture.makeRuntime();
    const result = await engine.investigate(__fixture.input, runtime);
    expect(result).toMatchObject({
      provider: 'openai',
      sessionId: 'openai:inc-9',
      outcome: 'inconclusive',
    });
    expect(result.disposition).not.toBe('rca');
    expect(steps).toEqual([{ kind: 'text', content: '{"summary":"bad deploy","confidence":60}' }]);
  });

  test('requires both an API key and a model', () => {
    expect(() => makeOpenAIEngine({ model: 'gpt-x' })).toThrow(/OPENAI_API_KEY/);
    expect(() => makeOpenAIEngine({ apiKey: 'k' })).toThrow(/OPENAI_MODEL/);
  });

  test('the post-budget finalizer exposes recorded evidence and report_findings through Chat Completions', async () => {
    const create = vi.fn(async (request: unknown) => {
      const tools = (request as { tools: Array<{ function: { name: string } }> }).tools;
      if (tools.some((tool) => tool.function.name === 'read_recorded_evidence')) {
        return __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_report',
            'report_findings',
            '{"outcome":"conclusive","summary":"bounded evidence assessment","confidence":64,"rankedHypotheses":[]}',
          ),
        );
      }
      return __fixture.toolCallTurn(
        __fixture.toolCall('call_metrics', 'query_metrics', '{"service":"api","windowMinutes":5}'),
      );
    });
    const metrics = __fixture.probeTool('query_metrics', []);
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x', maxTurns: 2 },
      { chat: { completions: { create } } },
    );
    const { runtime } = __fixture.makeRuntime([metrics.tool]);

    const result = await engine.investigate(__fixture.input, runtime);

    expect(result).toMatchObject({ summary: 'bounded evidence assessment', confidence: 64 });
    expect(create).toHaveBeenCalledTimes(3);
    const finalRequest = create.mock.calls[2]![0] as {
      tool_choice: { type: string; function: { name: string } };
      tools: Array<{ function: { name: string } }>;
    };
    expect(finalRequest.tool_choice).toBeUndefined();
    expect(finalRequest.tools.map((tool) => tool.function.name)).toEqual([
      'report_findings',
      'read_recorded_evidence',
    ]);
  });
});

describe('makeOpenAIEngine shared tool loop', () => {
  test('investigate binds the tenant tools and report terminal, dispatches calls in order, and returns the RCA', async () => {
    const metrics = __fixture.probeTool('query_metrics', [{ errorRate: 0.42 }]);
    const logs = __fixture.probeTool('search_logs', [{ message: 'pool exhausted' }]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_metrics',
            'query_metrics',
            '{"service":"api","windowMinutes":30}',
          ),
          __fixture.toolCall('call_logs', 'search_logs', '{"service":"api","windowMinutes":30}'),
        ),
      )
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_report',
            'report_findings',
            '{"outcome":"conclusive","summary":"database pool exhausted","confidence":84,"rankedHypotheses":[]}',
          ),
        ),
      );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { audit, runtime, steps } = __fixture.makeRuntime([metrics.tool, logs.tool]);

    const result = await engine.investigate(__fixture.input, runtime);

    expect(create).toHaveBeenCalledTimes(2);
    const firstRequest = create.mock.calls[0]![0] as {
      model: string;
      tools: Array<{ function: { name: string } }>;
    };
    expect(firstRequest.model).toBe('gpt-x');
    expect(firstRequest.tools.map((spec) => spec.function.name).sort()).toEqual([
      'query_metrics',
      'report_findings',
      'search_logs',
    ]);

    const secondRequest = create.mock.calls[1]![0] as {
      messages: Array<{
        role: string;
        tool_call_id?: string;
        tool_calls?: ReturnType<typeof __fixture.toolCall>[];
      }>;
    };
    expect(secondRequest.messages.slice(-3).map((message) => message.role)).toEqual([
      'assistant',
      'tool',
      'tool',
    ]);
    expect(secondRequest.messages.slice(-2).map((message) => message.tool_call_id)).toEqual([
      'call_metrics',
      'call_logs',
    ]);
    expect(secondRequest.messages.at(-3)).toMatchObject({
      role: 'assistant',
      tool_calls: [
        { id: 'call_metrics', type: 'function', function: { name: 'query_metrics' } },
        { id: 'call_logs', type: 'function', function: { name: 'search_logs' } },
      ],
    });
    expect(steps.map((step) => step.content.split(' ')[0])).toEqual([
      'query_metrics',
      'search_logs',
    ]);
    expect(audit.records.map((record) => record.tool)).toEqual(['query_metrics', 'search_logs']);
    expect(result).toMatchObject({
      provider: 'openai',
      model: 'gpt-x',
      outcome: 'conclusive',
      disposition: 'rca',
      summary: 'database pool exhausted',
      confidence: 84,
    });
  });

  // prettier-ignore
  test('resume reconstructs Hub context and evidence, binds every resume terminal, and returns a reply', async () => {
    const metrics = __fixture.probeTool('query_metrics', []);
    const create = vi.fn().mockResolvedValueOnce(
      __fixture.toolCallTurn(
        __fixture.toolCall(
          'call_reply',
          'respond',
          '{"summary":"The pool recovered","detail":"Connections returned after the rollback."}',
        ),
      ),
    );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const toolStepSentinel = 'stale tool step must not be replayed';
    const resumeInput: ResumeInput = {
      ...__fixture.input,
      humanMessage: 'Did the rollback fix it?',
      prior: [
        { author: 'agent', kind: 'tool_step', content: toolStepSentinel },
        { author: 'agent', kind: 'finding', content: 'The database pool was exhausted.' },
      ],
      evidence: [
        {
          tool: 'query_metrics',
          input: { service: 'api', windowMinutes: 30 },
          output: [{ activeConnections: 12 }],
          createdAt: '2026-08-13T00:00:00.000Z',
        },
      ],
    };
    const { runtime } = __fixture.makeRuntime([metrics.tool]);

    const result = await engine.resume(resumeInput, runtime);

    expect(create).toHaveBeenCalledTimes(1);
    const request = create.mock.calls[0]![0] as {
      tools: Array<{ function: { name: string } }>;
      messages: Array<{ role: string; content: string }>;
    };
    expect(request.tools.map((spec) => spec.function.name).sort()).toEqual([
      'query_metrics',
      'report_findings',
      'respond',
      'stay_silent',
      'suggest_action',
    ]);
    const user = request.messages.find((message) => message.role === 'user')!.content;
    expect(user).toContain('The database pool was exhausted.');
    expect(user).toContain('Evidence already gathered');
    expect(user).toContain('activeConnections');
    expect(user).toContain('Did the rollback fix it?');
    expect(user).not.toContain(toolStepSentinel);
    expect(result).toMatchObject({
      disposition: 'reply',
      summary: 'The pool recovered',
      detail: 'Connections returned after the rollback.',
    });
  });

  test('malformed function arguments become fixed invalid-input feedback without dispatch or audit', async () => {
    const metrics = __fixture.probeTool('query_metrics', [{ errorRate: 0.42 }]);
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(__fixture.toolCall('call_bad', 'query_metrics', '{not json')),
      )
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_report',
            'report_findings',
            '{"outcome":"conclusive","summary":"insufficient evidence","confidence":20,"rankedHypotheses":[]}',
          ),
        ),
      );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { audit, runtime } = __fixture.makeRuntime([metrics.tool]);

    const result = await engine.investigate(__fixture.input, runtime);

    expect(create).toHaveBeenCalledTimes(2);
    const retryRequest = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    expect(retryRequest.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad',
      content: 'error: invalid tool input',
    });
    expect(retryRequest.messages.at(-1)?.content).not.toContain('{not json');
    expect(metrics.handler).not.toHaveBeenCalled();
    expect(audit.records).toEqual([]);
    expect(result).toMatchObject({
      disposition: 'rca',
      summary: 'insufficient evidence',
      confidence: 20,
    });
  });

  test('malformed terminal arguments receive invalid-input feedback before a valid conclusion', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall('call_bad_report', 'report_findings', '{not json'),
        ),
      )
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_report',
            'report_findings',
            '{"outcome":"conclusive","summary":"validated conclusion","confidence":72,"rankedHypotheses":[]}',
          ),
        ),
      );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    expect(create).toHaveBeenCalledTimes(2);
    const retryRequest = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    expect(retryRequest.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad_report',
      content: 'error: invalid tool input',
    });
    expect(result).toMatchObject({
      disposition: 'rca',
      summary: 'validated conclusion',
      confidence: 72,
    });
  });
});

describe('makeOpenAIEngine resume and provider failures', () => {
  const resumeInput: ResumeInput = {
    ...__fixture.input,
    humanMessage: 'go ahead',
    prior: [{ author: 'agent', kind: 'finding', content: 'checkout pods are wedged' }],
  };

  function toolCallResponses(args: string) {
    const ids: string[] = [];
    const create = vi.fn(async (_request: unknown) => {
      const id = `call_${ids.length + 1}`;
      ids.push(id);
      return {
        choices: [
          {
            message: {
              tool_calls: [
                { id, type: 'function', function: { name: 'suggest_action', arguments: args } },
              ],
            },
          },
        ],
      };
    });
    return {
      sdk: { chat: { completions: { create } } } as OpenAILike,
      create,
      ids: () => ids,
    };
  }

  test('resume turns suggest_action into canonical content and fixed decisions without provider IDs', async () => {
    const { sdk, create, ids } = toolCallResponses(
      '{"level":"L2","explanation":"The checkout pods are wedged.","action":"kubectl rollout undo deployment/checkout"}',
    );
    const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
    const { runtime } = __fixture.makeRuntime();
    const result = await engine.resume(resumeInput, runtime);
    expect(result.disposition).toBe('approval');
    expect(result.approval).toEqual({
      prompt:
        'Recommended Action (L2)\n\nThe checkout pods are wedged.\n\nCommand or rollback reference:\nkubectl rollout undo deployment/checkout',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'deny', label: 'Deny' },
      ],
    });
    expect((result as { toolCallId?: string }).toolCallId).toBeUndefined();
    expect((result.approval as { actionId?: string }).actionId).toBeUndefined();
    const request = create.mock.calls[0]![0] as {
      tools: Array<{
        type: string;
        function: {
          name: string;
          parameters: {
            properties?: Record<string, Record<string, unknown>>;
            required?: string[];
          };
        };
      }>;
    };
    for (const tool of request.tools) {
      expect(tool.type).toBe('function');
      expect(tool.function.parameters).not.toHaveProperty('$schema');
      expect(tool.function.parameters).toMatchObject({ type: 'object' });
    }
    const schema = request.tools.find((tool) => tool.function.name === 'suggest_action')!.function
      .parameters;
    expect(schema.required).toEqual(expect.arrayContaining(['level', 'explanation', 'action']));
    expect(schema.properties?.level).toMatchObject({ enum: ['L2', 'L3'] });
    expect(schema.properties?.explanation).toMatchObject({ type: 'string', pattern: '\\S' });
    expect(schema.properties?.action).toMatchObject({ type: 'string', pattern: '\\S' });
    const again = await engine.resume(resumeInput, runtime);
    expect(ids()[1]).not.toBe(ids()[0]);
    expect(again.approval).toEqual(result.approval);
  });

  test('malformed suggest_action arguments receive fixed feedback and the resume continues', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall('call_bad_suggestion', 'suggest_action', '{not json'),
        ),
      )
      .mockResolvedValueOnce(
        __fixture.toolCallTurn(
          __fixture.toolCall(
            'call_reply',
            'respond',
            '{"summary":"No action recorded","detail":"Please provide a valid recommendation."}',
          ),
        ),
      );
    const engine = makeOpenAIEngine(
      { apiKey: 'k', model: 'gpt-x' },
      { chat: { completions: { create } } },
    );
    const { audit, runtime } = __fixture.makeRuntime();

    const result = await engine.resume(resumeInput, runtime);

    expect(create).toHaveBeenCalledTimes(2);
    const retry = create.mock.calls[1]![0] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    expect(retry.messages.at(-1)).toMatchObject({
      role: 'tool',
      tool_call_id: 'call_bad_suggestion',
      content: 'error: invalid tool input',
    });
    expect(retry.messages.at(-1)?.content).not.toContain('{not json');
    expect(audit.records).toEqual([]);
    expect(result).toMatchObject({ disposition: 'reply', summary: 'No action recorded' });
    expect(result.approval).toBeUndefined();
  });

  test('resume returns an inconclusive outcome when the model stops without a terminal', async () => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: vi.fn(async () => ({
            choices: [{ message: { content: '{"summary":"bad deploy","confidence":60}' } }],
          })),
        },
      },
    };
    const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
    const { runtime } = __fixture.makeRuntime();
    const result = await engine.resume(resumeInput, runtime);
    expect(result).toMatchObject({ outcome: 'inconclusive' });
    expect(result.disposition).not.toBe('rca');
    expect(result.approval).toBeUndefined();
  });

  test.each([undefined, 408, 409, 429, 503])(
    'classifies provider status %s without retrying rate limits',
    async (status) => {
      const sdk: OpenAILike = {
        chat: {
          completions: {
            create: vi.fn(async () => {
              throw new OpenAI.APIError(status, undefined, 'provider detail', undefined);
            }),
          },
        },
      };
      const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
      const { runtime } = __fixture.makeRuntime();

      await expect(engine.investigate(__fixture.input, runtime)).rejects.toEqual(
        status === 429
          ? new ProviderRateLimitError()
          : new ProviderUnavailableError('openai provider unavailable'),
      );
    },
  );

  test('sanitizes hard provider failures without exposing the response body', async () => {
    const sdk: OpenAILike = {
      chat: {
        completions: {
          create: vi.fn(async () => {
            throw new OpenAI.APIError(
              422,
              { detail: 'SECRET_RESPONSE_BODY' },
              'SECRET_PROVIDER_MESSAGE',
              undefined,
            );
          }),
        },
      },
    };
    const engine = makeOpenAIEngine({ apiKey: 'k', model: 'gpt-x' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    await expect(engine.investigate(__fixture.input, runtime)).rejects.toThrow(
      /^openai request failed with status 422$/,
    );
  });
});
