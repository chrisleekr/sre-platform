import { describe, expect, test, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  selectClassifier,
  makeFakeClassifier,
  makeClaudeClassifier,
  makeOpenAIClassifier,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_TOOL_NAME,
  type CorrelationVerdict,
} from '../classify';
import type { AnthropicLike } from '../claude';
import type { OpenAILike } from '../openai';
import {
  ProviderConfigurationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from '../types';
import type { LlmConfig } from '../../config';
import type { InboundCandidate } from '@sre/connectors';
import type { IncidentSummary } from '@sre/db';
import type { ResolutionCandidate } from '../correlation';

// relevance classifier selection + injectable fake. Mirrors selectEngine
// (engine/select.ts + select.test.ts): one provider per deployment, no cross-provider fallback,
// fail-fast on an unset/unknown provider. No real network LLM calls in these tests.

function cfg(partial: Partial<LlmConfig>): LlmConfig {
  return {
    provider: partial.provider ?? '',
    anthropic: partial.anthropic ?? { model: 'claude-opus-4-8' },
    openai: partial.openai ?? {},
  };
}

const candidate: InboundCandidate = {
  externalId: '1699999999.0001',
  channel: 'C123',
  author: 'human',
  text: 'checkout is throwing 500s for everyone',
  raw: { ts: '1699999999.0001', text: 'checkout is throwing 500s for everyone' },
  signalState: 'unknown',
  eventKey: 'slack:C123:1699999999.0001',
  eventAt: '2026-08-21T00:00:00.000Z',
  contentHash: 'hash',
  isEdit: false,
};

describe('selectClassifier (one provider, no fallback)', () => {
  test('fake is available for dev and tests', () => {
    expect(typeof selectClassifier(cfg({ provider: 'fake' })).classify).toBe('function');
  });

  test('claude with a credential resolves to a classifier', () => {
    const c = selectClassifier(
      cfg({ provider: 'claude', anthropic: { apiKey: 'sk-x', model: 'claude-opus-4-8' } }),
    );
    expect(typeof c.classify).toBe('function');
  });

  test('claude without a credential fails fast', () => {
    expect(() => selectClassifier(cfg({ provider: 'claude' }))).toThrow(
      /ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/,
    );
  });

  test('openai requires both an API key and a model', () => {
    expect(
      typeof selectClassifier(
        cfg({ provider: 'openai', openai: { apiKey: 'sk-x', model: 'gpt-x' } }),
      ).classify,
    ).toBe('function');
    expect(() => selectClassifier(cfg({ provider: 'openai', openai: { model: 'gpt-x' } }))).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => selectClassifier(cfg({ provider: 'openai', openai: { apiKey: 'sk-x' } }))).toThrow(
      /OPENAI_MODEL/,
    );
  });

  test('an unset or unknown provider fails fast', () => {
    expect(() => selectClassifier(cfg({ provider: '' }))).toThrow(/Invalid LLM_PROVIDER/);
    expect(() => selectClassifier(cfg({ provider: 'bogus' }))).toThrow(/Invalid LLM_PROVIDER/);
  });
});

test('provider bot alerts are structurally described as investigation-worthy', async () => {
  expect(CLASSIFY_SYSTEM_PROMPT).toContain('Never choose not_worthy for those alerts.');
  await expect(
    selectClassifier(cfg({ provider: 'fake' })).classify(
      {
        ...candidate,
        author: 'bot',
        alertKind: 'firing',
        text: 'SSL certificate expires in 30 days',
      },
      [],
    ),
  ).resolves.toMatchObject({ decision: 'new_incident', severity: 'sev3' });
});

test('fake classifier keeps non-alert bot deployment notices out of incidents', async () => {
  await expect(
    selectClassifier(cfg({ provider: 'fake' })).classify(
      { ...candidate, author: 'bot', text: 'Deployment failed for checkout-api' },
      [],
    ),
  ).resolves.toEqual({ decision: 'not_worthy' });
});

describe('makeFakeClassifier (injectable verdict for dev and tests)', () => {
  test('delegates to the injected fn (candidate + candidates) and returns its CorrelationVerdict', async () => {
    const result: CorrelationVerdict = {
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev2',
      title: 'checkout 500s',
    };
    const fn = vi.fn(async () => result);
    const c = makeFakeClassifier(fn);
    await expect(c.classify(candidate, [])).resolves.toEqual(result);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(candidate, [], []);
  });

  test('accepts a synchronous fn (returns CorrelationVerdict, not a Promise)', async () => {
    const c = makeFakeClassifier(() => ({ decision: 'not_worthy' }));
    await expect(c.classify(candidate, [])).resolves.toEqual({ decision: 'not_worthy' });
  });

  test('propagates a thrown error from the injected fn as a rejection', async () => {
    const c = makeFakeClassifier(() => {
      throw new Error('boom');
    });
    await expect(c.classify(candidate, [])).rejects.toThrow('boom');
  });
});

// APIError.generate returns an APIConnectionError (status undefined) on falsy headers, so a
// status-specific subclass needs a real Headers object — mirrors engine/claude.test.ts.
const H = (): Headers => new Headers();

function claudeSdk(create: (req: unknown) => Promise<unknown>): AnthropicLike {
  return { messages: { create } };
}

function toolUse(input: unknown) {
  return { content: [{ type: 'tool_use', name: CLASSIFY_TOOL_NAME, input }] };
}

describe('makeClaudeClassifier (strict-tool structured output)', () => {
  const config = { apiKey: 'sk-x', model: 'claude-opus-4-8' };

  test('a valid tool_use verdict resolves to the CorrelationVerdict', async () => {
    const verdict = {
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev2',
      title: 'checkout 500s',
    };
    const sdk = claudeSdk(vi.fn(async () => toolUse(verdict)));
    await expect(makeClaudeClassifier(config, sdk).classify(candidate, [])).resolves.toEqual(
      verdict,
    );
  });

  test('sends one strict tool under auto choice and names it in the system prompt', async () => {
    const create = vi.fn(async (_req: unknown) => toolUse({ decision: 'not_worthy' }));
    await makeClaudeClassifier(config, claudeSdk(create)).classify(candidate, []);
    const req = create.mock.calls[0]![0] as {
      tools: Array<{ name: string; strict?: boolean; input_schema: unknown }>;
      tool_choice: unknown;
      system: string;
    };
    // Opus 5.5 returns 400 for tool_choice tool/any, so the call is steered by prompt and schema.
    expect(req.tool_choice).toEqual({ type: 'auto' });
    expect(req.tools).toHaveLength(1);
    expect(req.tools[0]).toMatchObject({ name: CLASSIFY_TOOL_NAME, strict: true });
    expect(JSON.stringify(req.tools[0]!.input_schema)).toContain('"additionalProperties":false');
    expect(req.system).toContain(`Respond only by calling ${CLASSIFY_TOOL_NAME}.`);
  });

  test('a prose answer with no tool call throws instead of dropping the message', async () => {
    const sdk = claudeSdk(vi.fn(async () => ({ content: [{ type: 'text', text: 'not worthy' }] })));
    await expect(makeClaudeClassifier(config, sdk).classify(candidate, [])).rejects.toThrow(
      /classify verdict unparseable/,
    );
  });

  test('a rejected request configuration is a ProviderConfigurationError', async () => {
    const sdk = claudeSdk(
      vi.fn(async () => {
        throw Anthropic.APIError.generate(400, { detail: 'PROMPT-LEAK' }, 'bad', H());
      }),
    );
    const error = await makeClaudeClassifier(config, sdk)
      .classify(candidate, [])
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderConfigurationError);
    expect((error as Error).message).not.toContain('PROMPT-LEAK');
  });

  test('an unparseable verdict throws (fails open, not a silent drop)', async () => {
    const sdk = claudeSdk(vi.fn(async () => toolUse({ not: 'a verdict' })));
    await expect(makeClaudeClassifier(config, sdk).classify(candidate, [])).rejects.toThrow(
      /classify verdict unparseable/,
    );
  });

  test('a rate limit is distinct from a provider outage', async () => {
    const sdk = claudeSdk(
      vi.fn(async () => {
        throw Anthropic.APIError.generate(429, undefined, 'rl', H());
      }),
    );
    await expect(makeClaudeClassifier(config, sdk).classify(candidate, [])).rejects.toBeInstanceOf(
      ProviderRateLimitError,
    );
  });

  test('a 5xx/no-status provider failure rejects with ProviderUnavailableError', async () => {
    for (const err of [
      Anthropic.APIError.generate(503, undefined, 'down', H()),
      new Anthropic.APIConnectionError({ message: 'conn refused' }),
    ]) {
      const sdk = claudeSdk(
        vi.fn(async () => {
          throw err;
        }),
      );
      await expect(
        makeClaudeClassifier(config, sdk).classify(candidate, []),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test('a hard error is sanitized — the thrown message carries no raw provider text (CWE-209)', async () => {
    const sdk = claudeSdk(
      vi.fn(async () => {
        throw new Error('leak SECRET-MARKER-xyz');
      }),
    );
    await expect(makeClaudeClassifier(config, sdk).classify(candidate, [])).rejects.toThrow(
      /claude request failed/,
    );
    await makeClaudeClassifier(config, sdk)
      .classify(candidate, [])
      .catch((e: Error) => expect(e.message).not.toContain('SECRET-MARKER-xyz'));
  });
});

function openaiSdk(create: (req: unknown) => Promise<unknown>): OpenAILike {
  return { chat: { completions: { create } } };
}

const openaiCompletion = (content: string) => ({ choices: [{ message: { content } }] });

describe('makeOpenAIClassifier (JSON-only, defensive parse)', () => {
  const config = { apiKey: 'k', model: 'gpt-x' };

  test('valid JSON resolves to the parsed CorrelationVerdict', async () => {
    const sdk = openaiSdk(
      vi.fn(async () =>
        openaiCompletion(
          '{"decision":"new_incident","service":"api","severity":"sev1","title":"t"}',
        ),
      ),
    );
    await expect(makeOpenAIClassifier(config, sdk).classify(candidate, [])).resolves.toEqual({
      decision: 'new_incident',
      service: 'api',
      severity: 'sev1',
      title: 't',
    });
  });

  test('prose or malformed JSON throws (fails open, not a silent drop)', async () => {
    const prose = openaiSdk(vi.fn(async () => openaiCompletion('sorry, no json here')));
    await expect(makeOpenAIClassifier(config, prose).classify(candidate, [])).rejects.toThrow(
      /classify verdict unparseable/,
    );
    const malformed = openaiSdk(vi.fn(async () => openaiCompletion('{"decision": }')));
    await expect(makeOpenAIClassifier(config, malformed).classify(candidate, [])).rejects.toThrow(
      /classify verdict unparseable/,
    );
  });

  test('a 429/503/no-status APIError rejects with ProviderUnavailableError', async () => {
    for (const err of [
      new OpenAI.APIError(429, undefined, 'rl', undefined),
      new OpenAI.APIError(503, undefined, 'down', undefined),
      new OpenAI.APIError(undefined, undefined, 'conn', undefined),
    ]) {
      const sdk = openaiSdk(
        vi.fn(async () => {
          throw err;
        }),
      );
      await expect(
        makeOpenAIClassifier(config, sdk).classify(candidate, []),
      ).rejects.toBeInstanceOf(ProviderUnavailableError);
    }
  });

  test('a 422 APIError is sanitized to its status only — no response body leaks (CWE-209)', async () => {
    const sdk = openaiSdk(
      vi.fn(async () => {
        throw new OpenAI.APIError(422, { detail: 'BODY-MARKER-abc' }, 'bad', undefined);
      }),
    );
    let thrown: unknown;
    await makeOpenAIClassifier(config, sdk)
      .classify(candidate, [])
      .catch((e) => {
        thrown = e;
      });
    expect((thrown as Error).message).toBe('classify request failed with status 422');
    expect((thrown as Error).message).not.toContain('BODY-MARKER-abc');
  });

  test('a 400/401/403/404 APIError is a ProviderConfigurationError without provider text', async () => {
    for (const status of [400, 401, 403, 404]) {
      const sdk = openaiSdk(
        vi.fn(async () => {
          throw new OpenAI.APIError(status, { detail: 'BODY-MARKER-abc' }, 'bad', undefined);
        }),
      );
      await expect(makeOpenAIClassifier(config, sdk).classify(candidate, [])).rejects.toEqual(
        new ProviderConfigurationError(status),
      );
    }
  });

  test('a non-APIError rejects with the generic sanitized message', async () => {
    const sdk = openaiSdk(
      vi.fn(async () => {
        throw new Error('our bug');
      }),
    );
    await expect(makeOpenAIClassifier(config, sdk).classify(candidate, [])).rejects.toThrow(
      /^classify request failed$/,
    );
  });
});

const withText = (text: string): InboundCandidate => ({
  externalId: '1',
  channel: 'C1',
  author: 'human',
  text,
  raw: { text },
  signalState: 'unknown',
  eventKey: 'slack:C1:1',
  eventAt: '2026-08-21T00:00:00.000Z',
  contentHash: text,
  isEdit: false,
});

// --- correlation verdict over a candidate list ------------------------------------
// classify() takes a candidates list and returns a discriminated CorrelationVerdict:
//   { decision: 'not_worthy' } | { decision: 'resolves_signal'; signalIndex } |
//   { decision: 'belongs_to'; index } | { decision: 'new_incident'; … }
// The terminal verdict tool emits it (Claude sends tool_choice auto, since Opus 5.5 rejects a forced
// choice); the candidate block is injected into the user prompt so the model selects an OPAQUE
// 1-based index (never a UUID). A schema miss still THROWS (fail-open).

function incidentSummary(over: Partial<IncidentSummary> & { title?: string }): IncidentSummary {
  return {
    id: over.id ?? 'inc-x',
    service: over.service ?? 'checkout',
    severity: over.severity ?? 'sev2',
    status: 'open',
    alertSource: 'slack',
    rcaSummary: null,
    confidence: null,
    createdAt: new Date(),
    ...over,
  } as IncidentSummary;
}

const CORR_CANDIDATES: IncidentSummary[] = [
  incidentSummary({ id: 'inc-A', service: 'checkout', severity: 'sev2', title: 'Checkout 5xx' }),
  incidentSummary({
    id: 'inc-B',
    service: 'payments',
    severity: 'sev1',
    title: 'Payments latency',
  }),
];

const RESOLUTION_CANDIDATES: ResolutionCandidate[] = [
  {
    id: 'signal-A',
    incidentId: 'inc-A',
    externalMessageId: '1787900810.813739',
    channel: 'C123',
    summary: 'luxuryescapes.com went Down with HTTP 504',
    service: 'website',
    title: 'luxuryescapes.com down',
    severity: 'sev1',
  },
];

describe('makeClaudeClassifier correlation verdict', () => {
  const config = { apiKey: 'sk-x', model: 'claude-opus-4-8' };

  test('a belongs_to tool_use resolves to the belongs_to verdict', async () => {
    const verdict = { decision: 'belongs_to', index: 1 };
    const sdk = claudeSdk(vi.fn(async () => toolUse(verdict)));
    await expect(
      makeClaudeClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).resolves.toEqual(verdict);
  });

  test('a new_incident tool_use resolves to the new_incident verdict', async () => {
    const verdict = { decision: 'new_incident', service: 'checkout', severity: 'sev2', title: 't' };
    const sdk = claudeSdk(vi.fn(async () => toolUse(verdict)));
    await expect(
      makeClaudeClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).resolves.toEqual(verdict);
  });

  test('a not_worthy tool_use resolves to the not_worthy verdict', async () => {
    const sdk = claudeSdk(vi.fn(async () => toolUse({ decision: 'not_worthy' })));
    await expect(
      makeClaudeClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).resolves.toEqual({ decision: 'not_worthy' });
  });

  test('a recovery tool_use selects an authorized unresolved signal by opaque index', async () => {
    const verdict = { decision: 'resolves_signal' as const, signalIndex: 1 };
    let seen: unknown;
    const sdk = claudeSdk(
      vi.fn(async (request: unknown) => {
        seen = request;
        return toolUse(verdict);
      }),
    );

    await expect(
      makeClaudeClassifier(config, sdk).classify(
        { ...candidate, text: 'luxuryescapes.com went back up' },
        CORR_CANDIDATES,
        RESOLUTION_CANDIDATES,
      ),
    ).resolves.toEqual(verdict);

    const prompt = JSON.stringify(seen);
    expect(prompt).toContain('luxuryescapes.com went Down with HTTP 504');
    expect(prompt).not.toContain('signal-A');
    expect(prompt).not.toContain('inc-A');
  });

  test('an unparseable verdict still throws (fail-open preserved, not a silent drop)', async () => {
    const sdk = claudeSdk(vi.fn(async () => toolUse({ not: 'a verdict' })));
    await expect(
      makeClaudeClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).rejects.toThrow(/classify verdict unparseable/);
  });

  test('the candidate block is injected into the user prompt as opaque 1-based indices', async () => {
    let seen: unknown;
    const sdk = claudeSdk(
      vi.fn(async (req: unknown) => {
        seen = req;
        return toolUse({ decision: 'not_worthy' });
      }),
    );
    await makeClaudeClassifier(config, sdk).classify(candidate, CORR_CANDIDATES);
    const prompt = JSON.stringify(seen);
    expect(prompt).toContain('[1]');
    expect(prompt).toContain('[2]');
    expect(prompt).toContain('Checkout 5xx');
    // The UUID-ish id must never reach the model — selection is by opaque index.
    expect(prompt).not.toContain('inc-A');
  });
});

describe('makeOpenAIClassifier correlation verdict', () => {
  const config = { apiKey: 'k', model: 'gpt-x' };

  test('valid belongs_to JSON resolves to the verdict', async () => {
    const sdk = openaiSdk(
      vi.fn(async () => openaiCompletion('{"decision":"belongs_to","index":2}')),
    );
    await expect(
      makeOpenAIClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).resolves.toEqual({ decision: 'belongs_to', index: 2 });
  });

  test('valid new_incident JSON resolves to the verdict', async () => {
    const sdk = openaiSdk(
      vi.fn(async () =>
        openaiCompletion(
          '{"decision":"new_incident","service":"api","severity":"sev1","title":"t"}',
        ),
      ),
    );
    await expect(
      makeOpenAIClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).resolves.toEqual({ decision: 'new_incident', service: 'api', severity: 'sev1', title: 't' });
  });

  test('valid resolves_signal JSON resolves to the verdict', async () => {
    const sdk = openaiSdk(
      vi.fn(async () => openaiCompletion('{"decision":"resolves_signal","signalIndex":1}')),
    );
    await expect(
      makeOpenAIClassifier(config, sdk).classify(candidate, [], RESOLUTION_CANDIDATES),
    ).resolves.toEqual({ decision: 'resolves_signal', signalIndex: 1 });
  });

  test('a malformed verdict still throws (fail-open preserved)', async () => {
    const sdk = openaiSdk(vi.fn(async () => openaiCompletion('sorry, no json here')));
    await expect(
      makeOpenAIClassifier(config, sdk).classify(candidate, CORR_CANDIDATES),
    ).rejects.toThrow(/classify verdict unparseable/);
  });
});

describe('selectClassifier fake default (defaultFakeRelevance)', () => {
  test('a trigger word opens a new incident', async () => {
    const c = selectClassifier(cfg({ provider: 'fake' }));
    await expect(c.classify(withText('checkout returning 500 errors'), [])).resolves.toMatchObject({
      decision: 'new_incident',
    });
  });

  test('benign chatter is not worthy', async () => {
    const c = selectClassifier(cfg({ provider: 'fake' }));
    await expect(c.classify(withText('good morning team'), [])).resolves.toEqual({
      decision: 'not_worthy',
    });
  });
});
