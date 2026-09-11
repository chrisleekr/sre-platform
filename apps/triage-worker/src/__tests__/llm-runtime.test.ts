import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import {
  llmInvocations,
  makeDb,
  tenants,
  withTenant,
  type DbHandle,
  type PlatformSecretStore,
} from '@sre/db';
import type { LlmRuntimeConfig } from '@sre/contracts';
import { llmRuntimeFingerprint } from '@sre/platform-settings';
import { makeLlmRuntimeManager } from '../llm-runtime';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const config: LlmRuntimeConfig = {
  runtime: 'openai-chat',
  provider: 'openai',
  model: 'gpt-test',
  baseUrl: null,
  authMode: 'api-key',
  maxTurns: 4,
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 1.5,
  },
};

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

const settings = {
  llmRuntime: async () => ({
    config,
    source: 'stored' as const,
    updatedAt: new Date('2026-08-25T00:00:00.000Z'),
  }),
};

function secrets(value: string | null): PlatformSecretStore {
  return {
    get: vi.fn(async () => value),
    has: vi.fn(async () => value !== null),
    put: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
}

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values({ id: tenantId, name: 'LLM runtime test' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(llmInvocations).where(eq(llmInvocations.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('LLM runtime manager', () => {
  test.each([
    {
      name: 'an explicitly unverified deployment link',
      summary: 'GitHub PR 42 caused the deployed migration failure.',
      unknowns: [
        {
          question: 'The repository is a mirror. Which revision was deployed is unverified.',
          category: 'historical_gap',
          evidenceKind: 'deployment_as_of',
          attemptedEvidenceIds: [],
        },
      ],
      evidence: { repository: 'GitHub mirror', deployedRevision: null },
    },
    {
      name: 'logs-unavailable and healthy-delivery claims contradicted by current evidence',
      summary: 'Logs are unavailable. Delivery is healthy.',
      unknowns: [],
      evidence: { logs: 'migration checksum mismatch', syncStatus: 'Failed' },
    },
  ])(
    'does not return a conclusive assessment with $name',
    async ({ summary, unknowns, evidence }) => {
      const evidenceId = randomUUID();
      const requestBodies: string[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
          requestBodies.push(String(init?.body));
          return new Response(
            JSON.stringify({
              id: randomUUID(),
              object: 'chat.completion',
              created: 1,
              model: config.model,
              choices: [
                {
                  index: 0,
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: null,
                    tool_calls: [
                      {
                        id: randomUUID(),
                        type: 'function',
                        function: {
                          name: 'report_findings',
                          arguments: JSON.stringify({
                            outcome: 'conclusive',
                            summary,
                            confidence: 95,
                            unknowns,
                            evidenceIds: [evidenceId],
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 20, completion_tokens: 10 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }),
      );
      const manager = makeLlmRuntimeManager({
        db: app.db,
        settings,
        secrets: secrets('fixture-key'),
      });
      const incidentId = randomUUID();
      const result = await manager.execute(
        { tenantId, jobId: randomUUID(), operation: 'investigate' },
        ({ engine }) =>
          engine.investigate(
            {
              incident: {
                id: incidentId,
                tenantId,
                service: 'checkout',
                severity: 'sev2',
                fingerprint: randomUUID(),
                alertSource: 'test',
              },
              evidence: [
                {
                  id: evidenceId,
                  tool: 'read_current_deployment',
                  input: {},
                  output: evidence,
                  createdAt: new Date(),
                },
              ],
            },
            {
              tools: [],
              signal: new AbortController().signal,
              onStep: async () => undefined,
              ctx: {
                tenantId,
                incidentId,
                service: 'checkout',
                resolveConnectors: async () => [],
                audit: { record: async () => evidenceId },
              },
            },
          ),
      );
      expect(requestBodies.join('\n')).toContain(evidenceId);
      expect(result.outcome).not.toBe('conclusive');
    },
  );

  test('fails closed when the runtime changes during a gated model operation', async () => {
    const changed = { ...config, model: 'gpt-changed' };
    const runtime = vi
      .fn()
      .mockResolvedValueOnce({ config, source: 'stored', updatedAt: new Date() })
      .mockResolvedValueOnce({ config: changed, source: 'stored', updatedAt: new Date() });
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: { llmRuntime: runtime },
      secrets: secrets('stored-key'),
    });

    await expect(
      manager.execute(
        {
          tenantId,
          jobId: randomUUID(),
          operation: 'classify',
          expectedConfigurationFingerprint: llmRuntimeFingerprint(config),
        },
        async () => ({ disposition: 'ticket' }),
      ),
    ).rejects.toThrow(/changed during/i);
  });

  test('uses the stored credential and completes a priced immutable usage row', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer stored-key');
      return new Response(
        JSON.stringify({
          id: 'completion-1',
          object: 'chat.completion',
          created: 1,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '{"ok":true}' },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 4 },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetch);
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings,
      secrets: secrets('stored-key'),
      env: { OPENAI_API_KEY: 'environment-key' },
    });
    const jobId = randomUUID();

    await expect(
      manager.execute({ tenantId, jobId, operation: 'runbook-distill' }, ({ generator }) =>
        generator.generate('Return ok', z.object({ ok: z.boolean() })),
      ),
    ).resolves.toEqual({ ok: true });

    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(llmInvocations).where(eq(llmInvocations.jobId, jobId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'succeeded',
      runtime: 'openai-chat',
      provider: 'openai',
      model: 'gpt-test',
      requestCount: 1,
      inputTokens: 6,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 0,
      usageReported: true,
      config,
      pricing: config.pricing,
      configUpdatedAt: new Date('2026-08-25T00:00:00.000Z'),
    });
    expect(Number(rows[0]!.configuredCostUsd)).toBeCloseTo(0.000014);
  });

  test('records a failed invocation even when the provider rejects before reporting usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: 'bad request', type: 'invalid_request_error' } }),
            {
              status: 400,
              headers: { 'content-type': 'application/json' },
            },
          ),
      ),
    );
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings,
      secrets: secrets(null),
      env: { OPENAI_API_KEY: 'environment-key' },
    });
    const jobId = randomUUID();

    await expect(
      manager.execute({ tenantId, jobId, operation: 'characterize' }, ({ generator }) =>
        generator.generate('Return ok', z.object({ ok: z.boolean() })),
      ),
    ).rejects.toThrow('openai request failed');

    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(llmInvocations).where(eq(llmInvocations.jobId, jobId)),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'failed',
      requestCount: 0,
      usageReported: false,
      configuredCostUsd: null,
      errorCategory: 'Error',
    });
  });

  test('fails closed when a provider reports invalid token usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'completion-invalid-usage',
              object: 'chat.completion',
              created: 1,
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '{"ok":true}' },
                  finish_reason: 'stop',
                },
              ],
              usage: { prompt_tokens: 10, completion_tokens: -3 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings,
      secrets: secrets('stored-key'),
    });
    const jobId = randomUUID();

    await expect(
      manager.execute({ tenantId, jobId, operation: 'runbook-distill' }, ({ generator }) =>
        generator.generate('Return ok', z.object({ ok: z.boolean() })),
      ),
    ).resolves.toEqual({ ok: true });

    const row = (
      await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(llmInvocations).where(eq(llmInvocations.jobId, jobId)),
      )
    )[0];
    expect(row).toMatchObject({
      status: 'succeeded',
      usageReported: true,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      configuredCostUsd: null,
      providerEstimatedCostUsd: null,
    });
  });

  test.each([
    ['missing core usage', { prompt_tokens: 10 }],
    ['all-zero usage', { prompt_tokens: 0, completion_tokens: 0 }],
  ])('records %s as reported but unpriced', async (_name, usage) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'completion-unpriced-usage',
              object: 'chat.completion',
              created: 1,
              model: 'gpt-test',
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: '{"ok":true}' },
                  finish_reason: 'stop',
                },
              ],
              usage,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings,
      secrets: secrets('stored-key'),
    });
    const jobId = randomUUID();

    await manager.execute({ tenantId, jobId, operation: 'runbook-distill' }, ({ generator }) =>
      generator.generate('Return ok', z.object({ ok: z.boolean() })),
    );

    const row = (
      await withTenant(app.db, tenantId, (tx) =>
        tx.select().from(llmInvocations).where(eq(llmInvocations.jobId, jobId)),
      )
    )[0];
    expect(row).toMatchObject({
      usageReported: true,
      requestCount: 0,
      configuredCostUsd: null,
      providerEstimatedCostUsd: null,
    });
  });

  test('fails before constructing clients when a custom endpoint no longer passes the SSRF guard', async () => {
    const customConfig: LlmRuntimeConfig = {
      ...config,
      runtime: 'claude-agent-sdk',
      provider: 'custom-anthropic',
      model: 'claude-test',
      baseUrl: 'https://llm.internal.example',
    };
    const validateCustomProviderUrl = vi.fn(async () => {
      throw new Error('blocked endpoint');
    });
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: {
        llmRuntime: async () => ({
          config: customConfig,
          source: 'stored' as const,
          updatedAt: null,
        }),
      },
      secrets: secrets('custom-key'),
      validateCustomProviderUrl,
      env: { ANTHROPIC_API_KEY: 'must-not-be-used' },
    });
    const jobId = randomUUID();
    const run = vi.fn();

    await expect(manager.execute({ tenantId, jobId, operation: 'classify' }, run)).rejects.toThrow(
      'blocked endpoint',
    );
    expect(validateCustomProviderUrl).toHaveBeenCalledWith('https://llm.internal.example');
    expect(run).not.toHaveBeenCalled();
    const rows = await withTenant(app.db, tenantId, (tx) =>
      tx.select().from(llmInvocations).where(eq(llmInvocations.jobId, jobId)),
    );
    expect(rows[0]).toMatchObject({ status: 'failed', usageReported: false });
  });
});
