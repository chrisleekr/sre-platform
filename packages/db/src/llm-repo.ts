import {
  isUsableLlmPricing,
  type IncidentLlmUsage,
  type LlmOperation,
  type LlmPricing,
  type LlmProvider,
  type LlmRuntime,
  type LlmRuntimeConfig,
  type LlmTokenCounts,
  type LlmUsageSummary,
} from '@sre/contracts';
import { and, eq, gte, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { withTenant } from './rls';
import { llmInvocations, llmTelemetryEvents } from './schema';

export interface StartLlmInvocationInput {
  tenantId: string;
  incidentId?: string;
  jobId?: string;
  operation: LlmOperation;
  config: LlmRuntimeConfig;
  configUpdatedAt: Date | null;
}

export interface CompleteLlmInvocationInput {
  status: 'succeeded' | 'failed';
  errorCategory?: string;
  requestCount: number;
  tokens: LlmTokenCounts;
  usageReported: boolean;
  configuredCostUsd: number | null;
  providerEstimatedCostUsd: number | null;
  telemetryComplete: boolean | null;
}

export interface LlmTelemetryEventInput {
  kind: string;
  providerSequence?: number;
  providerTimestamp?: Date;
  model?: string;
  payload: unknown;
  bodyBytes?: number;
}

/**
 * Starts llm invocation.
 *
 * @param db - Database connection used for the operation.
 * @param input - Validated input for the operation.
 */
export async function startLlmInvocation(db: Db, input: StartLlmInvocationInput): Promise<string> {
  return withTenant(db, input.tenantId, async (tx) => {
    const rows = await tx
      .insert(llmInvocations)
      .values({
        tenantId: input.tenantId,
        incidentId: input.incidentId,
        jobId: input.jobId,
        operation: input.operation,
        runtime: input.config.runtime,
        provider: input.config.provider,
        model: input.config.model,
        config: input.config,
        pricing: input.config.pricing,
        configUpdatedAt: input.configUpdatedAt,
      })
      .returning({ id: llmInvocations.id });
    const id = rows[0]?.id;
    if (!id) throw new Error('LLM invocation insert returned no id');
    return id;
  });
}

/**
 * Completes llm invocation.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param invocationId - invocation id targeted by the operation.
 * @param input - Validated input for the operation.
 */
export async function completeLlmInvocation(
  db: Db,
  tenantId: string,
  invocationId: string,
  input: CompleteLlmInvocationInput,
): Promise<void> {
  await withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(llmInvocations)
      .set({
        status: input.status,
        errorCategory: input.errorCategory,
        requestCount: input.requestCount,
        inputTokens: input.tokens.input,
        outputTokens: input.tokens.output,
        cacheReadTokens: input.tokens.cacheRead,
        cacheWriteTokens: input.tokens.cacheWrite,
        usageReported: input.usageReported,
        configuredCostUsd:
          input.configuredCostUsd === null ? null : input.configuredCostUsd.toFixed(12),
        providerEstimatedCostUsd:
          input.providerEstimatedCostUsd === null
            ? null
            : input.providerEstimatedCostUsd.toFixed(12),
        telemetryComplete: input.telemetryComplete,
        completedAt: new Date(),
      })
      .where(and(eq(llmInvocations.tenantId, tenantId), eq(llmInvocations.id, invocationId)))
      .returning({ id: llmInvocations.id });
    if (rows.length !== 1) throw new Error('LLM invocation completion did not match one row');
  });
}

/**
 * Payload must already be recursively redacted.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param invocationId - invocation id targeted by the operation.
 * @param input - Validated input for the operation.
 */
export async function recordLlmTelemetryEvent(
  db: Db,
  tenantId: string,
  invocationId: string,
  input: LlmTelemetryEventInput,
): Promise<void> {
  await withTenant(db, tenantId, (tx) =>
    tx.insert(llmTelemetryEvents).values({
      tenantId,
      invocationId,
      kind: input.kind,
      providerSequence: input.providerSequence,
      providerTimestamp: input.providerTimestamp,
      model: input.model,
      payload: input.payload,
      bodyBytes: input.bodyBytes,
    }),
  );
}

/**
 * Reads platform llm usage summary.
 *
 * @param db - Database connection used for the operation.
 * @param from - Value supplied for from.
 * @param to - Target lifecycle status.
 */
export async function readPlatformLlmUsageSummary(
  db: Db,
  from: Date,
  to: Date,
): Promise<LlmUsageSummary> {
  const where = and(gte(llmInvocations.startedAt, from), lte(llmInvocations.startedAt, to));
  const dayBucket = sql<Date>`date_trunc('day', ${llmInvocations.startedAt} at time zone 'UTC') at time zone 'UTC'`;
  const [totalsRows, operationRows, modelRows, seriesRows] = await Promise.all([
    db
      .select({
        invocations: sql<string>`count(*)`,
        succeeded: sql<string>`count(*) filter (where ${llmInvocations.status} = 'succeeded')`,
        failed: sql<string>`count(*) filter (where ${llmInvocations.status} = 'failed')`,
        unpriced: sql<string>`count(*) filter (where ${llmInvocations.usageReported} and ${llmInvocations.configuredCostUsd} is null)`,
        missingUsage: sql<string>`count(*) filter (where not ${llmInvocations.usageReported})`,
        configuredCostUsd: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)`,
        providerEstimatedCount: sql<string>`count(${llmInvocations.providerEstimatedCostUsd})`,
        providerEstimatedCostUsd: sql<string>`coalesce(sum(${llmInvocations.providerEstimatedCostUsd}), 0)`,
        input: sql<string>`coalesce(sum(${llmInvocations.inputTokens}), 0)`,
        output: sql<string>`coalesce(sum(${llmInvocations.outputTokens}), 0)`,
        cacheRead: sql<string>`coalesce(sum(${llmInvocations.cacheReadTokens}), 0)`,
        cacheWrite: sql<string>`coalesce(sum(${llmInvocations.cacheWriteTokens}), 0)`,
      })
      .from(llmInvocations)
      .where(where),
    db
      .select({
        operation: llmInvocations.operation,
        invocations: sql<string>`count(*)`,
        configuredCostUsd: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)`,
        unpriced: sql<string>`count(*) filter (where ${llmInvocations.usageReported} and ${llmInvocations.configuredCostUsd} is null)`,
      })
      .from(llmInvocations)
      .where(where)
      .groupBy(llmInvocations.operation),
    db
      .select({
        runtime: llmInvocations.runtime,
        provider: llmInvocations.provider,
        model: llmInvocations.model,
        invocations: sql<string>`count(*)`,
        configuredCostUsd: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)`,
        unpriced: sql<string>`count(*) filter (where ${llmInvocations.usageReported} and ${llmInvocations.configuredCostUsd} is null)`,
      })
      .from(llmInvocations)
      .where(where)
      .groupBy(llmInvocations.runtime, llmInvocations.provider, llmInvocations.model),
    db
      .select({
        bucketAt: dayBucket,
        invocations: sql<string>`count(*)`,
        failed: sql<string>`count(*) filter (where ${llmInvocations.status} = 'failed')`,
        configuredCostUsd: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)`,
        tokens: sql<string>`coalesce(sum(${llmInvocations.inputTokens} + ${llmInvocations.outputTokens} + ${llmInvocations.cacheReadTokens} + ${llmInvocations.cacheWriteTokens}), 0)`,
      })
      .from(llmInvocations)
      .where(where)
      .groupBy(dayBucket)
      .orderBy(dayBucket),
  ]);
  const totals = totalsRows[0]!;
  const integer = (value: string): number => Number.parseInt(value, 10) || 0;
  const decimal = (value: string): number => Number(value) || 0;

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    invocations: integer(totals.invocations),
    succeeded: integer(totals.succeeded),
    failed: integer(totals.failed),
    unpriced: integer(totals.unpriced),
    missingUsage: integer(totals.missingUsage),
    configuredCostUsd: decimal(totals.configuredCostUsd),
    providerEstimatedCostUsd:
      integer(totals.providerEstimatedCount) === 0
        ? null
        : decimal(totals.providerEstimatedCostUsd),
    tokens: {
      input: integer(totals.input),
      output: integer(totals.output),
      cacheRead: integer(totals.cacheRead),
      cacheWrite: integer(totals.cacheWrite),
    },
    series: seriesRows.map((row) => ({
      bucketAt: new Date(row.bucketAt).toISOString(),
      invocations: integer(row.invocations),
      failed: integer(row.failed),
      configuredCostUsd: decimal(row.configuredCostUsd),
      tokens: integer(row.tokens),
    })),
    byOperation: operationRows
      .map((row) => ({
        operation: row.operation as LlmOperation,
        invocations: integer(row.invocations),
        configuredCostUsd: decimal(row.configuredCostUsd),
        unpriced: integer(row.unpriced),
      }))
      .sort(
        (a, b) =>
          b.configuredCostUsd - a.configuredCostUsd || a.operation.localeCompare(b.operation),
      ),
    byModel: modelRows
      .map((row) => ({
        runtime: row.runtime as LlmRuntime,
        provider: row.provider as LlmProvider,
        model: row.model,
        invocations: integer(row.invocations),
        configuredCostUsd: decimal(row.configuredCostUsd),
        unpriced: integer(row.unpriced),
      }))
      .sort((a, b) => b.configuredCostUsd - a.configuredCostUsd || a.model.localeCompare(b.model)),
  };
}

/**
 * Reads incident llm usage.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function readIncidentLlmUsage(
  db: Db,
  tenantId: string,
  incidentId: string,
): Promise<IncidentLlmUsage> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        invocations: sql<string>`count(*)`,
        configuredCostUsd: sql<string>`coalesce(sum(${llmInvocations.configuredCostUsd}), 0)`,
        providerEstimatedCount: sql<string>`count(${llmInvocations.providerEstimatedCostUsd})`,
        providerEstimatedCostUsd: sql<string>`coalesce(sum(${llmInvocations.providerEstimatedCostUsd}), 0)`,
        unpriced: sql<string>`count(*) filter (where ${llmInvocations.usageReported} and ${llmInvocations.configuredCostUsd} is null)`,
        missingUsage: sql<string>`count(*) filter (where not ${llmInvocations.usageReported})`,
        input: sql<string>`coalesce(sum(${llmInvocations.inputTokens}), 0)`,
        output: sql<string>`coalesce(sum(${llmInvocations.outputTokens}), 0)`,
        cacheRead: sql<string>`coalesce(sum(${llmInvocations.cacheReadTokens}), 0)`,
        cacheWrite: sql<string>`coalesce(sum(${llmInvocations.cacheWriteTokens}), 0)`,
      })
      .from(llmInvocations)
      .where(and(eq(llmInvocations.tenantId, tenantId), eq(llmInvocations.incidentId, incidentId)));
    const totals = rows[0]!;
    const integer = (value: string): number => Number.parseInt(value, 10) || 0;
    const decimal = (value: string): number => Number(value) || 0;
    return {
      incidentId,
      invocations: integer(totals.invocations),
      configuredCostUsd: decimal(totals.configuredCostUsd),
      providerEstimatedCostUsd:
        integer(totals.providerEstimatedCount) === 0
          ? null
          : decimal(totals.providerEstimatedCostUsd),
      unpriced: integer(totals.unpriced),
      missingUsage: integer(totals.missingUsage),
      tokens: {
        input: integer(totals.input),
        output: integer(totals.output),
        cacheRead: integer(totals.cacheRead),
        cacheWrite: integer(totals.cacheWrite),
      },
    };
  });
}

/**
 * Calculates configured LLM cost from provider token usage.
 *
 * @param tokens - Value supplied for tokens.
 * @param pricing - Value supplied for pricing.
 */
export function priceLlmTokens(tokens: LlmTokenCounts, pricing: LlmPricing | null): number | null {
  if (!isUsableLlmPricing(pricing)) return null;
  const buckets = [
    [tokens.input, pricing.inputPerMTok],
    [tokens.output, pricing.outputPerMTok],
    [tokens.cacheRead, pricing.cacheReadPerMTok],
    [tokens.cacheWrite, pricing.cacheWritePerMTok],
  ] as const;
  if (buckets.some(([count]) => !Number.isSafeInteger(count) || count < 0)) return null;
  if (buckets.every(([count]) => count === 0)) return null;
  if (buckets.some(([count, rate]) => count > 0 && rate <= 0)) return null;
  const perMillion = (value: number, rate: number): number => (value / 1_000_000) * rate;
  const cost =
    perMillion(tokens.input, pricing.inputPerMTok) +
    perMillion(tokens.output, pricing.outputPerMTok) +
    perMillion(tokens.cacheRead, pricing.cacheReadPerMTok) +
    perMillion(tokens.cacheWrite, pricing.cacheWritePerMTok);
  return Number.isFinite(cost) && cost >= 0 ? cost : null;
}
