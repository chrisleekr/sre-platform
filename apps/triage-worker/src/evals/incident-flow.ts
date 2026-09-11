import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { eq } from 'drizzle-orm';
import { makeDb, makePlatformSecretStore, tenants, llmInvocations } from '@sre/db';
import { runMigrations } from '../../../../packages/db/src/migrate';
import { PlatformSettings, llmRuntimeFingerprint } from '@sre/platform-settings';
import { makeLlmRuntimeManager } from '../llm-runtime';
import { classifyLifecycleIntent } from '../lifecycle-intent';
import { characterizeThread } from '../engine/characterize';
import { evidenceReviewSchema, EVIDENCE_REVIEW_INSTRUCTION } from '../engine/evidence-review';
import { correctionReviewSchema, CORRECTION_REVIEW_INSTRUCTION } from '../worker/reconcile';
import { withEvaluationReport, type EvaluationState } from './evaluation-report';
import {
  lifecycleCases,
  correctionCases,
  purposeCases,
  evidenceCases,
  isCorrectedDiagnosticGuide,
} from './incident-flow-cases';

/** Run synthetic semantic cases with the selected model and disposable telemetry storage. */
async function main(): Promise<void> {
  if (!process.argv.includes('--run'))
    throw new Error('Pass --run to authorize model calls for synthetic evaluation.');
  const sourceUrl = process.env.DATABASE_URL;
  const filter = process.env.INCIDENT_FLOW_EVAL_FILTER;
  const selectedCase = (name: string) => !filter || new RegExp(filter).test(name);
  if (!sourceUrl || !['localhost', '127.0.0.1', '[::1]'].includes(new URL(sourceUrl).hostname))
    throw new Error('Evaluation configuration must come from a loopback development database.');
  const source = makeDb(sourceUrl);
  const redis = new Redis(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
    lazyConnect: true,
  });
  const selected = await new PlatformSettings(source.db, redis, { env: process.env }).llmRuntime();
  const fingerprint = llmRuntimeFingerprint(selected.config);
  const secrets = makePlatformSecretStore(source.db, process.env.SECRETS_MASTER_KEY!);
  const pg = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withDatabase('sre_platform')
    .withUsername('sre')
    .withPassword('sre')
    .start();
  const evaluation = makeDb(pg.getConnectionUri());
  const tenantId = randomUUID();
  const state: EvaluationState = { passed: 0, failed: 0, currentCase: null };
  try {
    await runMigrations(pg.getConnectionUri());
    await evaluation.db
      .insert(tenants)
      .values({ id: tenantId, name: 'Synthetic incident-flow evaluation' });
    const manager = makeLlmRuntimeManager({
      db: evaluation.db,
      settings: { llmRuntime: async () => selected },
      secrets,
    });
    await withEvaluationReport(
      state,
      async () => {
        console.log(
          JSON.stringify({
            event: 'configuration',
            model: selected.config.model,
            provider: selected.config.provider,
            runtime: selected.config.runtime,
            fingerprint,
          }),
        );
        const record = (name: string, ok: boolean, output: unknown): void => {
          if (ok) state.passed += 1;
          else state.failed += 1;
          console.log(JSON.stringify({ event: 'case', name, passed: ok, output }));
        };
        for (const item of lifecycleCases) {
          if (!selectedCase(item.name)) continue;
          state.currentCase = item.name;
          const signal = AbortSignal.timeout(120_000);
          const output = await manager.execute(
            { tenantId, operation: 'responder-intent', signal },
            ({ generator }) =>
              classifyLifecycleIntent(
                generator,
                item.message,
                signal,
                'newerMessages' in item ? [...item.newerMessages] : [],
              ),
          );
          record(item.name, output.kind === item.kind && output.to === item.to, output);
        }
        for (const item of correctionCases) {
          if (!selectedCase(item.name)) continue;
          state.currentCase = item.name;
          const signal = AbortSignal.timeout(60_000);
          const output = await manager.execute(
            { tenantId, operation: 'assessment-reconcile', signal },
            ({ generator }) =>
              generator.generate(
                JSON.stringify({
                  candidate: 'GitHub PR 42 caused the checkout deployment failure.',
                  newer: [item.message],
                }),
                correctionReviewSchema,
                { system: CORRECTION_REVIEW_INSTRUCTION, signal },
              ),
          );
          record(item.name, output.material === item.material, output);
        }
        for (const item of purposeCases) {
          if (!selectedCase(item.name)) continue;
          state.currentCase = item.name;
          const signal = AbortSignal.timeout(60_000);
          const output = await manager.execute(
            { tenantId, operation: 'characterize', signal },
            ({ generator }) => characterizeThread(generator, item.message, []),
          );
          record(
            item.name,
            output.decision === 'new_incident' && output.purpose === item.purpose,
            output,
          );
        }
        for (const item of evidenceCases) {
          if (!selectedCase(item.name)) continue;
          state.currentCase = item.name;
          const signal = AbortSignal.timeout(120_000);
          const evidence = item.data.map((output) => ({
            id: randomUUID(),
            tool: 'recorded_evidence',
            input: {},
            output,
            createdAt: '2026-09-10T09:26:00Z',
          }));
          const output = await manager.execute(
            { tenantId, operation: 'assessment-grade', signal },
            ({ generator }) =>
              generator.generate(
                JSON.stringify({
                  ...('task' in item ? { task: item.task } : {}),
                  candidate: {
                    summary: item.summary,
                    outcome: 'outcome' in item ? item.outcome : 'conclusive',
                    ...('disposition' in item ? { disposition: item.disposition } : {}),
                    unknowns: item.unknowns,
                    ...('detail' in item ? { disposition: 'reply', detail: item.detail } : {}),
                  },
                  evidence,
                }),
                evidenceReviewSchema,
                { system: EVIDENCE_REVIEW_INSTRUCTION, signal },
              ),
          );
          record(
            item.name,
            output.supported === item.supported &&
              (!('detail' in item) || isCorrectedDiagnosticGuide(output.detail)) &&
              output.evidenceIds.every((id) => evidence.some((entry) => entry.id === id)),
            output,
          );
        }
        state.currentCase = null;
      },
      () =>
        evaluation.db
          .select({
            operation: llmInvocations.operation,
            requests: llmInvocations.requestCount,
            input: llmInvocations.inputTokens,
            output: llmInvocations.outputTokens,
            configuredCostUsd: llmInvocations.configuredCostUsd,
          })
          .from(llmInvocations)
          .where(eq(llmInvocations.tenantId, tenantId)),
      (record) => console.log(JSON.stringify(record)),
    );
    if (state.failed) process.exitCode = 1;
  } finally {
    await evaluation.close();
    await pg.stop();
    await source.close();
    redis.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'evaluation_stopped',
      error: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  process.exitCode = 1;
});
