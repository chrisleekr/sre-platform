import { describe, expect, test, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  CLAUDE_CODE_IDENTIFIER,
  classifyProviderError,
  claudeAuthMode,
  makeClaudeEngine,
  sanitizeHardError,
  type AnthropicLike,
} from '../claude';

import { ProviderRateLimitError, ProviderUnavailableError } from '../types';
import type { ResumeInput } from '../types';

import { createFixture } from './claude.fixture';

const __fixture = createFixture();

const conclusiveFindings = (summary: string, confidence: number) => ({
  outcome: 'conclusive' as const,
  summary,
  confidence,
});

describe('claudeAuthMode', () => {
  test('prefers the API key when both are present', () => {
    expect(claudeAuthMode({ apiKey: 'k', oauthToken: 'o', model: 'm' })).toBe('apikey');
  });
  test('falls back to OAuth', () => {
    expect(claudeAuthMode({ oauthToken: 'o', model: 'm' })).toBe('oauth');
  });
  test('throws without a credential', () => {
    expect(() => claudeAuthMode({ model: 'm' })).toThrow(
      /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });
});

describe('makeClaudeEngine multi-turn tool loop', () => {
  test('recovery binds only report_recovery and returns its evidence proposal', async () => {
    const create = vi.fn().mockResolvedValueOnce(
      __fixture.toolUseTurn('recovery', 'report_recovery', {
        summary: 'Current error rate is back below threshold.',
        recovered: true,
        evidence: [{ name: 'Error rate', before: 'Above threshold', now: 'Below 1%' }],
        evidenceIds: ['11111111-1111-4111-8111-111111111111'],
        unknowns: [],
        nextStep: null,
      }),
    );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.verifyRecovery(
      { ...__fixture.input, prior: [], signalSummary: '[RESOLVED] CheckoutHighErrorRate' },
      runtime,
    );

    const names = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools
      .map((tool) => tool.name)
      .filter((name) => !runtime.tools.some((tool) => tool.name === name));
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
      __fixture.toolUseTurn('resume-recovery', 'report_recovery', {
        outcome: 'recovered',
        summary: 'Checkout is healthy again.',
        evidence: [{ name: 'Error rate', before: 'Above threshold', now: 'Below 1%' }],
        evidenceIds: ['11111111-1111-4111-8111-111111111111'],
        unknowns: [],
        nextStep: null,
      }),
    );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
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

    const names = (create.mock.calls[0]![0] as { tools: Array<{ name: string }> }).tools.map(
      (tool) => tool.name,
    );
    expect(names).toContain('report_recovery');
    expect(result).toMatchObject({
      disposition: 'recovery',
      recovery: { outcome: 'recovered', recovered: true },
    });
  });

  test('runs tool -> report_findings, binds tools, streams steps, and audits the run', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t1', 'datadog_query_metrics', { service: 'api', windowMinutes: 30 }),
      )
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', {
          outcome: 'conclusive',
          summary: 'db pool exhausted',
          confidence: 82,
          rankedHypotheses: [{ hypothesis: 'pool', confidence: 82, evidence: 'metrics' }],
        }),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { steps, runtime, audit } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    // Two model calls: the tool turn, then the report turn.
    expect(create).toHaveBeenCalledTimes(2);

    // The request bound the tools, including the terminal report_findings, each with a JSON schema.
    const req = create.mock.calls[0]![0] as {
      tools: Array<{ name: string; input_schema: unknown }>;
    };
    const toolNames = req.tools.map((t) => t.name);
    expect(toolNames).toContain('datadog_query_metrics');
    expect(toolNames).toContain('report_findings');
    for (const t of req.tools) expect(t.input_schema).toBeDefined();

    // The terminal report populated the result with an 'rca' disposition.
    expect(result).toMatchObject({
      provider: 'claude',
      sessionId: 'claude:inc-1',
      model: 'claude-opus-4-8',
      outcome: 'conclusive',
      disposition: 'rca',
      summary: 'db pool exhausted',
      confidence: 82,
    });
    expect(result.rankedHypotheses).toEqual([
      {
        hypothesis: 'pool',
        confidence: 82,
        evidence: 'metrics',
        supportingEvidenceIds: [],
        contradictingEvidenceIds: [],
      },
    ]);

    // The loop streams intermediate steps but NO longer the concluding finding — the worker appends it
    // from the returned disposition.
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toContain('tool_step');
    expect(kinds).not.toContain('finding');

    // datadog_query_metrics was dispatched through runTool and audited; report_findings is intercepted.
    const auditedTools = audit.records.map((r) => r.tool);
    expect(auditedTools).toContain('datadog_query_metrics');
    expect(auditedTools).not.toContain('report_findings');
  });

  test('redacts sensitive tool inputs in the tool_step content', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t1', 'datadog_search', {
          service: 'api',
          windowMinutes: 5,
          token: 'sk-secret',
        }),
      )
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('done', 50)),
      );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const { steps, runtime } = __fixture.makeRuntime();

    await engine.investigate(__fixture.input, runtime);

    const toolStep = steps.find((s) => s.kind === 'tool_step')!;
    expect(toolStep.content).toContain('[REDACTED]');
    expect(toolStep.content).not.toContain('sk-secret');
  });

  test('an empty tool result still yields a non-error tool_result and the loop continues', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t1', 'datadog_query_metrics', { service: 'api', windowMinutes: 30 }),
      )
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('ok', 60)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    expect(create).toHaveBeenCalledTimes(2);
    const tr = __fixture
      .toolResultsIn(create.mock.calls[1]![0])
      .find((c) => c.type === 'tool_result' && c.tool_use_id === 't1');
    expect(tr).toBeDefined();
    // The TOON encoding of an empty list. Empty data is rendered as data, never as an error.
    expect(tr!.content).toMatch(/^evidenceId: [0-9a-f-]{36}\ndata: \[\]$/);
    expect(tr!.is_error).toBe(false);
    expect(result.summary).toBe('ok');
  });

  test('an unknown tool name yields an is_error tool_result and does not throw', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(__fixture.toolUseTurn('t1', 'does_not_exist', { foo: 1 }))
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('z', 10)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    const tr = __fixture
      .toolResultsIn(create.mock.calls[1]![0])
      .find((c) => c.tool_use_id === 't1');
    expect(tr!.is_error).toBe(true);
    expect(result.summary).toBe('z');
  });

  test('malformed tool input degrades to an is_error result without throwing, and is not audited', async () => {
    // The model omits the required windowMinutes; runTool validates with `.parse` OUTSIDE its
    // try/catch, so a ZodError would escape the loop. The pre-dispatch guard must catch this.
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t1', 'datadog_query_metrics', { service: 'api' }),
      )
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('done', 55)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime, audit } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    const tr = __fixture
      .toolResultsIn(create.mock.calls[1]![0])
      .find((c) => c.tool_use_id === 't1');
    expect(tr!.is_error).toBe(true);
    expect(tr!.content).toBe('error: invalid tool input');
    // Skipped before runTool, so a schema-invalid call is never dispatched or audited.
    expect(audit.records.map((r) => r.tool)).not.toContain('datadog_query_metrics');
    expect(result.summary).toBe('done');
  });

  test('the post-budget finalizer exposes recorded evidence and report_findings without connector access', async () => {
    const create = vi.fn(async (request: unknown) => {
      const tools = (request as { tools: Array<{ name: string }> }).tools;
      if (tools.some((tool) => tool.name === 'read_recorded_evidence')) {
        return __fixture.toolUseTurn('r-final', 'report_findings', {
          outcome: 'conclusive',
          summary: 'bounded evidence assessment',
          confidence: 63,
          rankedHypotheses: [],
        });
      }
      return __fixture.toolUseTurn('tN', 'datadog_query_metrics', {
        service: 'api',
        windowMinutes: 5,
      });
    });
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8', maxTurns: 3 }, sdk);
    const { steps, runtime } = __fixture.makeRuntime();

    const result = await engine.investigate(__fixture.input, runtime);

    expect(create).toHaveBeenCalledTimes(4);
    expect(result.disposition).toBe('rca');
    expect(result.confidence).toBe(63);
    expect(result.summary).toBe('bounded evidence assessment');
    const finalRequest = create.mock.calls[3]![0] as {
      tool_choice: { type: string; name: string };
      tools: Array<{ name: string }>;
    };
    expect(finalRequest.tool_choice).toBeUndefined();
    expect(finalRequest.tools.map((tool) => tool.name)).toEqual([
      'report_findings',
      'read_recorded_evidence',
    ]);
    expect(steps.some((s) => s.kind === 'finding')).toBe(false);
  });

  test('OAuth mode prepends the Claude Code identifier as the first system block, tools still bound', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('x', 70)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ oauthToken: 'o', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    await engine.investigate(__fixture.input, runtime);

    const req = create.mock.calls[0]![0] as {
      system: Array<{ text: string }>;
      tools: Array<{ name: string }>;
    };
    expect(Array.isArray(req.system)).toBe(true);
    expect(req.system[0]!.text).toBe(CLAUDE_CODE_IDENTIFIER);
    expect(req.tools.some((t) => t.name === 'report_findings')).toBe(true);
  });

  test('throws without a credential', () => {
    expect(() => makeClaudeEngine({ model: 'claude-opus-4-8' })).toThrow(/ANTHROPIC_API_KEY/);
  });

  test('one engine binds only report_findings on investigate and adds suggest_action on resume', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        __fixture.toolUseTurn('t', 'report_findings', conclusiveFindings('s', 50)),
      );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const { runtime } = __fixture.makeRuntime();
    const boundIn = (req: unknown) =>
      (req as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    const dataTools = ['datadog_query_metrics', 'datadog_search'];

    await engine.investigate(__fixture.input, runtime);
    expect(boundIn(create.mock.calls[0]![0])).toEqual([...dataTools, 'report_findings'].sort());

    create.mockClear();
    await engine.resume({ ...__fixture.input, humanMessage: 'hi', prior: [] }, runtime);
    expect(boundIn(create.mock.calls[0]![0])).toEqual(
      [...dataTools, 'report_findings', 'respond', 'stay_silent', 'suggest_action'].sort(),
    );
  });
});

// the terminal COUNT lived only in prose, and it drifted. loop.ts PREVIOUSLY claimed a resume
// binds "all three" when it binds four; this MR corrected that. The binds-test above PREVIOUSLY
// asserted with toContain / arrayContaining, so it stayed GREEN when a fourth terminal was added and
// nothing failed as the claim went stale (it now asserts exact sets). These pin the exact SET, read off
// the specs actually sent to the model, so the next drift fails CI instead of shipping. The terminals
// are what the loop appends to the tenant's runtime tools, so subtract the runtime names rather than
// hardcoding them: the assertion then survives a change to the fixture's tools and still pins the
// terminals.
describe('Claude terminal binding, as an exact set', () => {
  const terminalsIn = (req: unknown, runtimeToolNames: string[]): string[] =>
    (req as { tools: Array<{ name: string }> }).tools
      .map((t) => t.name)
      .filter((name) => !runtimeToolNames.includes(name))
      .sort();

  test('a Claude investigate binds exactly one terminal: report_findings', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        __fixture.toolUseTurn('t', 'report_findings', conclusiveFindings('s', 50)),
      );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const { runtime } = __fixture.makeRuntime();

    await engine.investigate(__fixture.input, runtime);

    const names = runtime.tools.map((t) => t.name);
    expect(terminalsIn(create.mock.calls[0]![0], names)).toEqual(['report_findings']);
  });

  test('a Claude resume binds the constrained suggest_action terminal', async () => {
    const create = vi
      .fn()
      .mockResolvedValue(
        __fixture.toolUseTurn('t', 'report_findings', conclusiveFindings('s', 50)),
      );
    const engine = makeClaudeEngine(
      { apiKey: 'k', model: 'claude-opus-4-8' },
      { messages: { create } },
    );
    const { runtime } = __fixture.makeRuntime();

    await engine.resume({ ...__fixture.input, humanMessage: 'hi', prior: [] }, runtime);

    const names = runtime.tools.map((t) => t.name);
    const request = create.mock.calls[0]![0] as {
      tools: Array<{
        name: string;
        input_schema: {
          properties?: Record<string, Record<string, unknown>>;
          required?: string[];
        };
      }>;
    };
    expect(terminalsIn(request, names)).toEqual([
      'report_findings',
      'respond',
      'stay_silent',
      'suggest_action',
    ]);
    const schema = request.tools.find((tool) => tool.name === 'suggest_action')!.input_schema;
    expect(schema.required).toEqual(expect.arrayContaining(['level', 'explanation', 'action']));
    expect(schema.properties?.level).toMatchObject({ enum: ['L2', 'L3'] });
    expect(schema.properties?.explanation).toMatchObject({ type: 'string', pattern: '\\S' });
    expect(schema.properties?.action).toMatchObject({ type: 'string', pattern: '\\S' });
  });
});

describe('makeClaudeEngine resume', () => {
  test('seeds one textual user turn from the prior transcript + human reply; no exact tool replay', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('updated', 65)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const resumeInput: ResumeInput = {
      ...__fixture.input,
      humanMessage: 'Did you check the database connections?',
      prior: [
        {
          author: 'agent',
          kind: 'tool_step',
          content: 'datadog_query_metrics {"service":"checkout"}',
        },
        { author: 'agent', kind: 'finding', content: 'Possibly a deploy regression.' },
      ],
    };
    const result = await engine.resume(resumeInput, runtime);

    const firstReq = create.mock.calls[0]![0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    // Exactly one seed user turn, a plain string (textual reconstruction, not replayed blocks).
    expect(firstReq.messages).toHaveLength(1);
    expect(firstReq.messages[0]!.role).toBe('user');
    expect(typeof firstReq.messages[0]!.content).toBe('string');
    const seed = firstReq.messages[0]!.content as string;
    expect(seed).toContain('Possibly a deploy regression.');
    expect(seed).toContain('Did you check the database connections?');
    // No structured tool_use/tool_result blocks were replayed.
    expect(__fixture.toolResultsIn(firstReq)).toHaveLength(0);
    expect(result.summary).toBe('updated');
  });

  test('includes the incident header so the model has the service the tools require', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('ok', 60)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const resumeInput: ResumeInput = {
      ...__fixture.input, // incident.service === 'checkout'
      humanMessage: 'What about the cache?',
      prior: [{ author: 'agent', kind: 'finding', content: 'Inconclusive so far.' }], // omits service
    };
    await engine.resume(resumeInput, runtime);

    const seed = (create.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]!
      .content;
    // 'checkout' reaches the model via buildUserPrompt's header, not the transcript (which omits it).
    expect(seed).toContain('checkout');
    expect(seed).toContain('What about the cache?');
  });

  // Phase A RED for C4: resume renders a TOON "Evidence already gathered" block
  // from input.evidence, and DROPS tool_step-kind prior from the rendered transcript (the evidence
  // block supersedes it). Today ResumeInput has no `evidence` and renderPrior includes tool_step.
  test('C4 renders a TOON evidence block and excludes tool_step from the prior transcript', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(
        __fixture.toolUseTurn('t2', 'report_findings', conclusiveFindings('ok', 60)),
      );
    const sdk: AnthropicLike = { messages: { create } };
    const engine = makeClaudeEngine({ apiKey: 'k', model: 'claude-opus-4-8' }, sdk);
    const { runtime } = __fixture.makeRuntime();

    const TOOL_STEP_SENTINEL = 'TOOLSTEP_SENTINEL_should_be_excluded';
    const resumeInput = {
      ...__fixture.input,
      humanMessage: 'Anything from the metrics?',
      prior: [
        { author: 'agent', kind: 'tool_step', content: TOOL_STEP_SENTINEL },
        { author: 'agent', kind: 'finding', content: 'Prior finding kept in the transcript.' },
      ],
      // Reloaded evidence (latest-per-(tool,input)) fed back so the engine reuses, not re-fetches.
      evidence: [
        {
          tool: 'datadog_query_metrics',
          input: { service: 'checkout', windowMinutes: 30 },
          output: [{ cpu: 0.91 }, { cpu: 0.82 }],
          createdAt: new Date('2026-07-08T00:00:00Z'),
        },
      ],
    } as ResumeInput;
    await engine.resume(resumeInput, runtime);

    const seed = (create.mock.calls[0]![0] as { messages: Array<{ content: string }> }).messages[0]!
      .content;
    // The evidence block is present, labeled, and carries the gathered values as TOON tabular rows.
    expect(seed).toContain('Evidence already gathered');
    expect(seed).toContain('datadog_query_metrics');
    expect(seed).toMatch(/\[\d+\]\{/); // TOON `[N]{fields}:` header for the uniform output array
    expect(seed).toContain('0.91');
    // Non-tool_step prior stays; tool_step prior is dropped (evidence supersedes it).
    expect(seed).toContain('Prior finding kept in the transcript.');
    expect(seed).not.toContain(TOOL_STEP_SENTINEL);
  });
});

describe('classifyProviderError', () => {
  test('separates terminal rate limits from retryable availability failures', () => {
    expect(
      classifyProviderError(Anthropic.APIError.generate(429, undefined, 'rl', __fixture.H())),
    ).toBeInstanceOf(ProviderRateLimitError);
    expect(
      classifyProviderError(Anthropic.APIError.generate(503, undefined, 'down', __fixture.H())),
    ).toBeInstanceOf(ProviderUnavailableError);
    expect(
      classifyProviderError(new Anthropic.APIConnectionError({ message: 'conn refused' })),
    ).toBeInstanceOf(ProviderUnavailableError);
  });

  test('leaves auth / bad-request / non-API errors alone (they must not degrade-loop)', () => {
    expect(
      classifyProviderError(Anthropic.APIError.generate(401, undefined, 'auth', __fixture.H())),
    ).toBeNull();
    expect(
      classifyProviderError(Anthropic.APIError.generate(400, undefined, 'bad', __fixture.H())),
    ).toBeNull();
    expect(classifyProviderError(new Error('our bug'))).toBeNull();
  });

  test('the resulting message carries no raw provider/credential detail (CWE-209)', () => {
    const err = classifyProviderError(
      Anthropic.APIError.generate(429, undefined, 'token sk-ant-oat-leak', __fixture.H()),
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    expect(err?.message).not.toContain('sk-ant');
  });
});

describe('sanitizeHardError', () => {
  test('keeps the HTTP status but drops the raw provider response body (CWE-209)', () => {
    // APIError.message embeds the JSON body, which can echo the request (incident/alert data).
    const raw = Anthropic.APIError.generate(
      400,
      { detail: 'PROMPT-LEAK-abc123' },
      'bad',
      __fixture.H(),
    );
    const safe = sanitizeHardError(raw);
    expect(safe.message).toContain('400');
    expect(safe.message).not.toContain('PROMPT-LEAK');
  });

  test('a non-API error yields a fixed message with no raw text', () => {
    expect(sanitizeHardError(new Error('internal detail leak')).message).not.toContain('leak');
    expect(sanitizeHardError('weird throwable').message).toBe('claude request failed');
  });
});
