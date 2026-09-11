import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  completeLlmInvocation,
  createIncident,
  incidents,
  llmInvocations,
  llmTelemetryEvents,
  makeDb,
  priceLlmTokens,
  readIncidentLlmUsage,
  readPlatformLlmUsageSummary,
  recordLlmTelemetryEvent,
  startLlmInvocation,
  tenants,
  withTenant,
  type DbHandle,
} from '../index';
import type { LlmRuntimeConfig } from '@sre/contracts';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';

const config: LlmRuntimeConfig = {
  runtime: 'claude-agent-sdk',
  provider: 'anthropic',
  model: 'claude-test',
  baseUrl: null,
  authMode: 'api-key',
  maxTurns: 8,
  pricing: {
    inputPerMTok: 1,
    outputPerMTok: 2,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
  },
};

let admin: DbHandle;
let app: DbHandle;
const tenantA = randomUUID();
const tenantB = randomUUID();
let incidentId: string;

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  await admin.db.insert(tenants).values([
    { id: tenantA, name: 'LLM usage A' },
    { id: tenantB, name: 'LLM usage B' },
  ]);
  incidentId = (
    await createIncident(app.db, tenantA, {
      fingerprint: `llm-${randomUUID()}`,
      alertSource: 'test',
      service: 'checkout',
      severity: 'sev2',
    })
  ).id;
});

afterAll(async () => {
  if (admin) {
    await admin.db
      .delete(llmTelemetryEvents)
      .where(inArray(llmTelemetryEvents.tenantId, [tenantA, tenantB]));
    await admin.db
      .delete(llmInvocations)
      .where(inArray(llmInvocations.tenantId, [tenantA, tenantB]));
    await admin.db.delete(incidents).where(eq(incidents.id, incidentId));
    await admin.db.delete(tenants).where(inArray(tenants.id, [tenantA, tenantB]));
    await admin.close();
  }
  if (app) await app.close();
});

describe('LLM invocation ledger', () => {
  test('persists immutable config/pricing context, aggregates cost, and isolates tenant reads', async () => {
    const id = await startLlmInvocation(app.db, {
      tenantId: tenantA,
      incidentId,
      operation: 'investigate',
      config,
      configUpdatedAt: new Date('2026-08-25T00:00:00Z'),
    });
    const tokens = { input: 1_000, output: 500, cacheRead: 200, cacheWrite: 100 };
    await recordLlmTelemetryEvent(app.db, tenantA, id, {
      kind: 'api_request_body',
      providerSequence: 1,
      model: config.model,
      payload: { body: { prompt: '[redacted test body]' } },
      bodyBytes: 42,
    });
    await completeLlmInvocation(app.db, tenantA, id, {
      status: 'succeeded',
      requestCount: 3,
      tokens,
      usageReported: true,
      configuredCostUsd: priceLlmTokens(tokens, config.pricing),
      providerEstimatedCostUsd: 0.0123,
      telemetryComplete: true,
    });

    const tenantRows = await withTenant(app.db, tenantA, (tx) => tx.select().from(llmInvocations));
    expect(tenantRows).toHaveLength(1);
    expect(tenantRows[0]).toMatchObject({
      id,
      operation: 'investigate',
      model: config.model,
      requestCount: 3,
      inputTokens: 1_000,
      usageReported: true,
      telemetryComplete: true,
      config,
      pricing: config.pricing,
    });
    expect(await withTenant(app.db, tenantB, (tx) => tx.select().from(llmInvocations))).toEqual([]);

    const incident = await readIncidentLlmUsage(app.db, tenantA, incidentId);
    expect(incident).toMatchObject({
      incidentId,
      invocations: 1,
      unpriced: 0,
      missingUsage: 0,
      providerEstimatedCostUsd: 0.0123,
      tokens,
    });
    expect(incident.configuredCostUsd).toBeCloseTo(priceLlmTokens(tokens, config.pricing)!);

    const summaryStartedAt = new Date('2031-02-03T04:05:06.000Z');
    await admin.db
      .update(llmInvocations)
      .set({ startedAt: summaryStartedAt })
      .where(eq(llmInvocations.id, id));
    const summary = await readPlatformLlmUsageSummary(
      admin.db,
      new Date(summaryStartedAt.getTime() - 60_000),
      new Date(summaryStartedAt.getTime() + 60_000),
    );
    expect(summary).toMatchObject({
      invocations: 1,
      succeeded: 1,
      failed: 0,
      unpriced: 0,
      missingUsage: 0,
      tokens,
    });
    expect(summary.byOperation).toEqual([
      {
        operation: 'investigate',
        invocations: 1,
        configuredCostUsd: incident.configuredCostUsd,
        unpriced: 0,
      },
    ]);
    expect(summary.series).toHaveLength(1);
    expect(summary.series[0]).toMatchObject({
      invocations: 1,
      failed: 0,
      tokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite,
    });
  });

  test('groups the cost ledger into ordered daily usage buckets', async () => {
    const createdIds: string[] = [];
    const invocations = [
      {
        operation: 'investigate' as const,
        startedAt: new Date('2032-04-03T03:00:00.000Z'),
        status: 'succeeded' as const,
        tokens: { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
        cost: 0.01,
      },
      {
        operation: 'classify' as const,
        startedAt: new Date('2032-04-03T18:00:00.000Z'),
        status: 'failed' as const,
        tokens: { input: 20, output: 4, cacheRead: 5, cacheWrite: 6 },
        cost: null,
      },
      {
        operation: 'verify-recovery' as const,
        startedAt: new Date('2032-04-05T03:00:00.000Z'),
        status: 'succeeded' as const,
        tokens: { input: 30, output: 6, cacheRead: 7, cacheWrite: 8 },
        cost: 0.02,
      },
    ];

    for (const invocation of invocations) {
      const id = await startLlmInvocation(app.db, {
        tenantId: tenantB,
        operation: invocation.operation,
        config,
        configUpdatedAt: null,
      });
      createdIds.push(id);
      await completeLlmInvocation(app.db, tenantB, id, {
        status: invocation.status,
        requestCount: 1,
        tokens: invocation.tokens,
        usageReported: true,
        configuredCostUsd: invocation.cost,
        providerEstimatedCostUsd: null,
        telemetryComplete: true,
      });
      await admin.db
        .update(llmInvocations)
        .set({ startedAt: invocation.startedAt })
        .where(eq(llmInvocations.id, id));
    }

    const summary = await readPlatformLlmUsageSummary(
      admin.db,
      new Date('2032-04-03T00:00:00.000Z'),
      new Date('2032-04-05T23:59:59.999Z'),
    );
    await admin.db.delete(llmInvocations).where(inArray(llmInvocations.id, createdIds));

    expect(summary.series).toEqual([
      {
        bucketAt: '2032-04-03T00:00:00.000Z',
        invocations: 2,
        failed: 1,
        configuredCostUsd: 0.01,
        tokens: 54,
      },
      {
        bucketAt: '2032-04-05T00:00:00.000Z',
        invocations: 1,
        failed: 0,
        configuredCostUsd: 0.02,
        tokens: 51,
      },
    ]);
  });

  test('distinguishes missing usage from reported usage with no configured price', async () => {
    const unpricedId = await startLlmInvocation(app.db, {
      tenantId: tenantB,
      operation: 'classify',
      config: { ...config, pricing: null },
      configUpdatedAt: null,
    });
    await completeLlmInvocation(app.db, tenantB, unpricedId, {
      status: 'succeeded',
      requestCount: 1,
      tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
      usageReported: true,
      configuredCostUsd: null,
      providerEstimatedCostUsd: null,
      telemetryComplete: null,
    });
    const missingId = await startLlmInvocation(app.db, {
      tenantId: tenantB,
      operation: 'characterize',
      config,
      configUpdatedAt: null,
    });
    await completeLlmInvocation(app.db, tenantB, missingId, {
      status: 'failed',
      errorCategory: 'provider_unavailable',
      requestCount: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageReported: false,
      configuredCostUsd: null,
      providerEstimatedCostUsd: null,
      telemetryComplete: false,
    });

    const rows = await withTenant(app.db, tenantB, (tx) => tx.select().from(llmInvocations));
    expect(rows.filter((row) => row.usageReported && row.configuredCostUsd === null)).toHaveLength(
      1,
    );
    expect(rows.filter((row) => !row.usageReported)).toHaveLength(1);
  });
});

test('prices every token bucket using per-million custom rates', () => {
  expect(
    priceLlmTokens(
      { input: 1_000_000, output: 500_000, cacheRead: 250_000, cacheWrite: 100_000 },
      config.pricing,
    ),
  ).toBeCloseTo(2.15);
  expect(priceLlmTokens({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1 }, null)).toBeNull();
  expect(
    priceLlmTokens(
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 1, cacheWritePerMTok: 0 },
    ),
  ).toBeNull();
  expect(
    priceLlmTokens(
      { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
      { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    ),
  ).toBeNull();
  expect(
    priceLlmTokens(
      { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      { inputPerMTok: 1, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0 },
    ),
  ).toBeGreaterThan(0);
  expect(
    priceLlmTokens({ input: -1, output: 1, cacheRead: 0, cacheWrite: 0 }, config.pricing),
  ).toBeNull();
  expect(
    priceLlmTokens({ input: Number.NaN, output: 1, cacheRead: 0, cacheWrite: 0 }, config.pricing),
  ).toBeNull();
  expect(
    priceLlmTokens(
      { input: Number.MAX_SAFE_INTEGER + 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      config.pricing,
    ),
  ).toBeNull();
  expect(
    priceLlmTokens({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, config.pricing),
  ).toBeNull();
});

test('database constraints reject negative invocation usage', async () => {
  const id = await startLlmInvocation(app.db, {
    tenantId: tenantB,
    operation: 'classify',
    config,
    configUpdatedAt: null,
  });

  await expect(
    completeLlmInvocation(app.db, tenantB, id, {
      status: 'succeeded',
      requestCount: 1,
      tokens: { input: 1, output: -1, cacheRead: 0, cacheWrite: 0 },
      usageReported: true,
      configuredCostUsd: null,
      providerEstimatedCostUsd: null,
      telemetryComplete: true,
    }),
  ).rejects.toThrow();

  const zeroId = await startLlmInvocation(app.db, {
    tenantId: tenantB,
    operation: 'classify',
    config,
    configUpdatedAt: null,
  });
  await expect(
    completeLlmInvocation(app.db, tenantB, zeroId, {
      status: 'succeeded',
      requestCount: 1,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      usageReported: true,
      configuredCostUsd: 0,
      providerEstimatedCostUsd: null,
      telemetryComplete: true,
    }),
  ).rejects.toThrow();
});
