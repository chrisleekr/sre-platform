import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { makeOpenAIEngine, type OpenAILike } from '../openai';
import { makeInMemoryAuditSink } from '@sre/agent-tools';
import type { ResumeInput } from '../types';

/**
 * Gated smoke test for the resume terminal schemas. Stubbed tests cannot prove that the real Chat
 * Completions API accepts the Zod-derived function parameters. This sends one actual resume request;
 * a rejected schema throws before the assertions. It is skipped when OPENAI_API_KEY is absent.
 */
const RUN_LIVE = !!process.env.OPENAI_API_KEY;

const resumeInput: ResumeInput = {
  incident: {
    id: 'inc-live',
    tenantId: 't',
    service: 'api',
    severity: 'sev1',
    fingerprint: 'fp',
    alertSource: 'github',
  },
  humanMessage: 'The API is degraded — should we restart it?',
  prior: [
    {
      author: 'assistant',
      kind: 'investigation',
      content: 'Error rate spiked after the latest deploy.',
    },
  ],
};

describe.skipIf(!RUN_LIVE)('OpenAI resume terminal schemas, live API', () => {
  it('the real Chat Completions API accepts every bound resume terminal', async () => {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as unknown as OpenAILike;
    const model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
    const engine = makeOpenAIEngine(
      { apiKey: process.env.OPENAI_API_KEY, model, maxTurns: 1 },
      client,
    );
    const result = await engine.resume(resumeInput, {
      ctx: {
        tenantId: 't',
        incidentId: 'inc-live',
        service: 'api',
        resolveConnectors: async () => [],
        audit: makeInMemoryAuditSink(),
      },
      tools: [],
      signal: new AbortController().signal,
      onStep: async () => {},
    });

    expect(result.provider).toBe('openai');
    expect(result.model).toBe(model);
  }, 30_000);
});
