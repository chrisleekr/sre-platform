import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { makeDb, tenants, llmInvocations, type DbHandle, type PlatformSecretStore } from '@sre/db';
import { makeLlmRuntimeManager } from '../llm-runtime';
import type { LlmRuntimeConfig } from '@sre/contracts';

let db: DbHandle;
const tenantId = randomUUID();
beforeAll(async () => {
  db = makeDb(process.env.DATABASE_URL!);
  await db.db.insert(tenants).values({ id: tenantId, name: 'Recorded evidence finalization test' });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await db.db.delete(llmInvocations).where(eq(llmInvocations.tenantId, tenantId));
  await db.db.delete(tenants).where(eq(tenants.id, tenantId));
  await db.close();
});

test('the manager finalizer retrieves early recorded evidence and refuses foreign IDs without new connector reads', async () => {
  const early = randomUUID();
  const history = randomUUID();
  const foreign = randomUUID();
  const marker = 'checksum mismatch: stored aaa, deployed bbb';
  let finalTurns = 0;
  let reviews = 0;
  const externalReads = vi.fn();
  const auditIds = [early, history];
  const config: LlmRuntimeConfig = {
    provider: 'openai',
    runtime: 'openai-chat',
    model: 'fixture',
    baseUrl: null,
    authMode: 'api-key',
    maxTurns: 1,
    pricing: { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 1, cacheWritePerMTok: 1 },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const names: string[] = (body.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      );
      let message: object;
      const calls = (entries: Array<[string, object]>) => ({
        role: 'assistant',
        content: null,
        tool_calls: entries.map(([name, input]) => ({
          id: randomUUID(),
          type: 'function',
          function: { name, arguments: JSON.stringify(input) },
        })),
      });
      if (names.includes('read_failure'))
        message = calls([
          ['read_failure', {}],
          ['read_history', {}],
        ]);
      else if (names.includes('read_recorded_evidence')) {
        finalTurns += 1;
        expect(names).not.toContain('read_failure');
        expect(names).not.toContain('read_history');
        if (finalTurns === 1)
          message = calls([
            ['read_recorded_evidence', { evidenceId: foreign, offset: 0 }],
            ['read_recorded_evidence', { evidenceId: early, offset: 0 }],
          ]);
        else {
          const returned = body.messages
            .filter((item: { role: string }) => item.role === 'tool')
            .slice(-2)
            .map((item: { content: string }) => item.content);
          expect(returned[0]).toContain('error');
          expect(returned[1]).toContain(marker);
          expect(returned[1]).toContain(early);
          message = calls([
            [
              'report_findings',
              { outcome: 'conclusive', summary: marker, confidence: 80, evidenceIds: [early] },
            ],
          ]);
        }
      } else {
        reviews += 1;
        expect(JSON.stringify(body.messages)).toContain(marker);
        message = {
          role: 'assistant',
          content: JSON.stringify({
            supported: true,
            summary: marker,
            reason: 'Current logs support the finding.',
            evidenceIds: [early],
          }),
        };
      }
      return new Response(
        JSON.stringify({
          id: randomUUID(),
          object: 'chat.completion',
          created: 1,
          model: 'fixture',
          choices: [{ index: 0, finish_reason: 'stop', message }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const secrets: PlatformSecretStore = {
    get: async () => 'fixture-key',
    has: async () => true,
    put: async () => {},
    delete: async () => {},
  };
  const manager = makeLlmRuntimeManager({
    db: db.db,
    settings: { llmRuntime: async () => ({ config, source: 'stored', updatedAt: new Date() }) },
    secrets,
  });
  const result = await manager.execute({ tenantId, operation: 'investigate' }, ({ engine }) =>
    engine.investigate(
      {
        incident: {
          id: randomUUID(),
          tenantId,
          service: 'checkout',
          severity: 'sev2',
          fingerprint: 'failure',
          alertSource: 'manual',
        },
      },
      {
        tools: ['read_failure', 'read_history'].map((name) => ({
          name,
          description: name,
          inputSchema: z.object({}),
          handler: async () => {
            externalReads(name);
            return {
              available: true,
              data: name === 'read_failure' ? marker : 'Historical success. '.repeat(3_000),
            };
          },
        })),
        ctx: {
          tenantId,
          incidentId: randomUUID(),
          service: 'checkout',
          resolveConnectors: async () => [],
          audit: { record: async () => auditIds.shift() ?? randomUUID() },
        },
        signal: new AbortController().signal,
        onStep: async () => {},
      },
    ),
  );
  expect(result).toMatchObject({ outcome: 'conclusive', summary: marker });
  expect(finalTurns).toBe(2);
  expect(reviews).toBe(1);
  expect(externalReads).toHaveBeenCalledTimes(2);
});
