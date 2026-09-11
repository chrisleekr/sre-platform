/**
 * Model spend for the demo tenant.
 *
 * Deliberately mixed: priced work, work the provider reported without a configured price, and a
 * request the provider never reported usage for. The usage panel keeps those three apart, so the
 * screenshot has to contain all three.
 */
import { llmInvocations, withTenant } from '../../../packages/db/src/index';
import type { DemoSeedDeps } from './demo-environment';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export async function seedUsage(deps: DemoSeedDeps, incidentId: string): Promise<void> {
  const { now } = deps;
  const pricing = { inputPerMillionUsd: '3', outputPerMillionUsd: '15' };
  const config = { runtime: 'claude-agent-sdk', maxTurns: 8 };
  const rows: Omit<
    typeof llmInvocations.$inferInsert,
    'tenantId' | 'runtime' | 'provider' | 'model' | 'config'
  >[] = [
    {
      operation: 'triage',
      status: 'succeeded',
      inputTokens: 41_200,
      outputTokens: 3_180,
      cacheReadTokens: 18_400,
      requestCount: 6,
      usageReported: true,
      configuredCostUsd: '0.171300000000',
      telemetryComplete: true,
      startedAt: new Date(now.getTime() - 21 * MINUTE),
      completedAt: new Date(now.getTime() - 18 * MINUTE),
      incidentId,
    },
    {
      operation: 'resume',
      status: 'succeeded',
      inputTokens: 12_800,
      outputTokens: 940,
      requestCount: 2,
      usageReported: true,
      configuredCostUsd: '0.052500000000',
      telemetryComplete: true,
      startedAt: new Date(now.getTime() - 12 * MINUTE),
      completedAt: new Date(now.getTime() - 11 * MINUTE),
      incidentId,
    },
    {
      operation: 'triage',
      status: 'succeeded',
      inputTokens: 38_100,
      outputTokens: 2_400,
      requestCount: 5,
      usageReported: true,
      configuredCostUsd: '0.150300000000',
      telemetryComplete: true,
      startedAt: new Date(now.getTime() - 95 * MINUTE),
      completedAt: new Date(now.getTime() - 92 * MINUTE),
    },
    {
      operation: 'classify',
      status: 'succeeded',
      inputTokens: 2_100,
      outputTokens: 120,
      requestCount: 1,
      usageReported: true,
      telemetryComplete: true,
      startedAt: new Date(now.getTime() - 8 * MINUTE),
      completedAt: new Date(now.getTime() - 8 * MINUTE),
    },
    {
      operation: 'triage',
      status: 'failed',
      errorCategory: 'provider_unavailable',
      requestCount: 3,
      usageReported: false,
      telemetryComplete: false,
      startedAt: new Date(now.getTime() - 6 * MINUTE),
      completedAt: new Date(now.getTime() - 5 * MINUTE),
    },
  ];
  await withTenant(deps.appDb, deps.tenantId, (tx) =>
    tx.insert(llmInvocations).values(
      rows.map((row) => ({
        tenantId: deps.tenantId,
        runtime: 'claude-agent-sdk',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        config,
        pricing,
        configUpdatedAt: new Date(now.getTime() - 3 * DAY),
        ...row,
      })),
    ),
  );
}

/**
 * Fills a freshly migrated, empty tenant with the demo picture the documentation screenshots show.
 *
 * @param deps - Tenant-scoped connections, the queue, the snapshot cache, and the time anchor.
 */
