import { randomUUID } from 'node:crypto';
import type { InboundCandidate } from '@sre/connectors';
import type { LlmRuntimeConfig } from '@sre/contracts';
import { llmInvocations, makeDb, tenants, type DbHandle, type PlatformSecretStore } from '@sre/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

const selected = vi.hoisted(() => ({
  engine: { provider: 'stub' },
  classifier: { classify: vi.fn() },
  generator: { generate: vi.fn() },
  vision: { provider: 'stub', supportsVision: true, describeImage: vi.fn() },
}));

vi.mock('../engine/select', () => ({
  selectEngine: vi.fn(() => selected.engine),
  selectGenerator: vi.fn(() => selected.generator),
  selectVision: vi.fn(() => selected.vision),
}));

vi.mock('../engine/classify', () => ({
  selectClassifier: vi.fn(() => selected.classifier),
}));

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
  pricing: null,
};

const candidate: InboundCandidate = {
  externalId: 'message-1',
  channel: 'channel-1',
  author: 'human',
  text: 'checkout is returning 500s',
  raw: {},
  signalState: 'unknown',
  eventKey: 'slack:channel-1:message-1',
  eventAt: '2026-09-08T00:00:00.000Z',
  contentHash: 'hash',
  isEdit: false,
};

let admin: DbHandle;
let app: DbHandle;
const tenantId = randomUUID();

function runtimeSettings() {
  return {
    config,
    source: 'stored' as const,
    updatedAt: new Date('2026-09-08T00:00:00.000Z'),
  };
}

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
  await admin.db.insert(tenants).values({ id: tenantId, name: 'LLM runtime deadline test' });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  if (admin) {
    await admin.db.delete(llmInvocations).where(eq(llmInvocations.tenantId, tenantId));
    await admin.db.delete(tenants).where(eq(tenants.id, tenantId));
    await admin.close();
  }
  if (app) await app.close();
});

describe('LLM runtime deadline signal', () => {
  test('rejects an already-aborted reason before runtime work or run', async () => {
    const llmRuntime = vi.fn(async () => runtimeSettings());
    const secretStore = secrets('stored-key');
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: { llmRuntime },
      secrets: secretStore,
    });
    const run = vi.fn();
    const controller = new AbortController();
    const reason = new Error('deadline');
    controller.abort(reason);

    await expect(
      manager.execute({ tenantId, operation: 'classify', signal: controller.signal }, run),
    ).rejects.toBe(reason);
    expect(llmRuntime).not.toHaveBeenCalled();
    expect(secretStore.get).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test('injects the invocation signal into each one-shot client and preserves the engine', async () => {
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: { llmRuntime: async () => runtimeSettings() },
      secrets: secrets('stored-key'),
    });
    const controller = new AbortController();
    const schema = z.object({ ok: z.boolean() });
    const bytes = new ArrayBuffer(1);

    await manager.execute(
      {
        tenantId,
        jobId: randomUUID(),
        operation: 'classify',
        signal: controller.signal,
      },
      async ({ engine, generator, classifier, vision }) => {
        expect(engine.provider).toBe(selected.engine.provider);
        expect(engine.investigate).toBeTypeOf('function');
        await generator.generate('prompt', schema);
        await classifier.classify(candidate, []);
        await vision.describeImage(bytes, 'image/png', 'describe');
      },
    );

    expect(selected.generator.generate).toHaveBeenCalledWith('prompt', schema, {
      signal: controller.signal,
    });
    expect(selected.classifier.classify).toHaveBeenCalledWith(candidate, [], undefined, {
      signal: controller.signal,
    });
    expect(selected.vision.describeImage).toHaveBeenCalledWith(bytes, 'image/png', 'describe', {
      signal: controller.signal,
    });
  });

  test('keeps each caller-provided signal instead of replacing it', async () => {
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: { llmRuntime: async () => runtimeSettings() },
      secrets: secrets('stored-key'),
    });
    const invocation = new AbortController();
    const caller = new AbortController();
    const schema = z.object({ ok: z.boolean() });
    const bytes = new ArrayBuffer(1);

    await manager.execute(
      {
        tenantId,
        jobId: randomUUID(),
        operation: 'classify',
        signal: invocation.signal,
      },
      async ({ generator, classifier, vision }) => {
        await generator.generate('prompt', schema, { system: 'system', signal: caller.signal });
        await classifier.classify(candidate, [], undefined, { signal: caller.signal });
        await vision.describeImage(bytes, 'image/png', 'describe', { signal: caller.signal });
      },
    );

    expect(selected.generator.generate).toHaveBeenCalledWith('prompt', schema, {
      system: 'system',
      signal: caller.signal,
    });
    expect(selected.classifier.classify).toHaveBeenCalledWith(candidate, [], undefined, {
      signal: caller.signal,
    });
    expect(selected.vision.describeImage).toHaveBeenCalledWith(bytes, 'image/png', 'describe', {
      signal: caller.signal,
    });
  });

  test('passes the selected clients through unchanged without an invocation signal', async () => {
    const manager = makeLlmRuntimeManager({
      db: app.db,
      settings: { llmRuntime: async () => runtimeSettings() },
      secrets: secrets('stored-key'),
    });

    await manager.execute(
      { tenantId, jobId: randomUUID(), operation: 'classify' },
      async ({ engine, generator, classifier, vision }) => {
        expect(engine.provider).toBe(selected.engine.provider);
        expect(engine.investigate).toBeTypeOf('function');
        expect(generator).toBe(selected.generator);
        expect(classifier).toBe(selected.classifier);
        expect(vision).toBe(selected.vision);
      },
    );
  });
});
