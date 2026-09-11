import {
  claimSignalDispositionEvaluation,
  completeSignalDispositionEvaluation,
  failSignalDispositionEvaluation,
  type Db,
} from '@sre/db';
import type { JobHandler } from '@sre/queue';
import type { LlmRuntimeManager } from './llm-runtime';
import { SIGNAL_DISPOSITION_SCENARIOS } from './engine/signal-disposition-corpus';
import {
  classifyDurableSignal,
  scoreSignalDispositionCorpus,
  semanticDispositionSchema,
} from './engine/signal-disposition';
import { projectDurableSignalContext } from './engine/signal-context';

/** Executes every reviewed scenario through one metered decision per scenario. */
export async function evaluateSignalDispositionCorpus(
  llm: LlmRuntimeManager,
  job: { id: string; tenantId: string },
  runtimeFingerprint: string,
  signal: AbortSignal,
) {
  const predictions = new Map<
    string,
    {
      disposition: string;
      decision: string;
      index?: number;
      signalIndex?: number;
      action?: string;
      safeDeferralReason?: string;
      riskIfIgnored?: string;
      reviewHorizonMinutes?: number;
    }
  >();
  for (const scenario of SIGNAL_DISPOSITION_SCENARIOS) {
    const prediction = await llm.execute(
      {
        tenantId: job.tenantId,
        jobId: job.id,
        operation: 'classify',
        expectedConfigurationFingerprint: runtimeFingerprint,
        signal,
      },
      ({ generator }) =>
        classifyDurableSignal(
          projectDurableSignalContext({
            signalId: scenario.id,
            jobId: job.id,
            summary: scenario.message,
            author: scenario.durableContext.author,
            providerGroupKey: scenario.durableContext.providerGroupKey,
            signalState: scenario.durableContext.signalState,
            correlationCandidates: scenario.durableContext.correlationCandidates,
            resolutionCandidates: scenario.durableContext.resolutionCandidates,
          }),
          {
            generate: (request, system) =>
              generator.generate(JSON.stringify(request), semanticDispositionSchema, {
                system,
                signal,
              }),
          },
        ),
    );
    predictions.set(scenario.id, {
      disposition: prediction.disposition,
      decision: prediction.decision,
      ...(prediction.index === undefined ? {} : { index: prediction.index }),
      ...(prediction.signalIndex === undefined ? {} : { signalIndex: prediction.signalIndex }),
      ...(prediction.disposition === 'ticket'
        ? {
            action: prediction.action,
            safeDeferralReason: prediction.safeDeferralReason,
            riskIfIgnored: prediction.riskIfIgnored,
            reviewHorizonMinutes: prediction.reviewHorizonMinutes,
          }
        : {}),
    });
  }
  return scoreSignalDispositionCorpus(SIGNAL_DISPOSITION_SCENARIOS, predictions);
}

/** Runs the reviewed corpus against the exact metered runtime selected for live classification. */
export function makeSignalEvaluationHandler(deps: { db: Db; llm: LlmRuntimeManager }): JobHandler {
  return async (job, ctx) => {
    if (job.type !== 'signal.disposition.evaluate') return;
    const evaluationId = (job.payload as { evaluationId?: unknown }).evaluationId;
    if (typeof evaluationId !== 'string') return;
    const evaluation = await claimSignalDispositionEvaluation(
      deps.db,
      job.tenantId,
      evaluationId,
      job.id,
    );
    if (!evaluation) return;
    try {
      const runtimeFingerprint = await deps.llm.configurationFingerprint?.();
      if (!runtimeFingerprint || runtimeFingerprint !== evaluation.runtimeFingerprint) {
        throw new Error('runtime_configuration_changed');
      }
      const score = await evaluateSignalDispositionCorpus(
        deps.llm,
        job,
        evaluation.runtimeFingerprint,
        ctx.signal,
      );
      if ((await deps.llm.configurationFingerprint?.()) !== evaluation.runtimeFingerprint) {
        throw new Error('runtime_configuration_changed');
      }
      await completeSignalDispositionEvaluation(deps.db, job.tenantId, evaluation.id, {
        ...score,
        classMetrics: score.classMetrics,
        scenarioResults: score.scenarioResults,
      });
    } catch (error) {
      if (ctx.signal.aborted) throw ctx.signal.reason;
      await failSignalDispositionEvaluation(
        deps.db,
        job.tenantId,
        evaluation.id,
        error instanceof Error && error.message === 'runtime_configuration_changed'
          ? 'runtime_configuration_changed'
          : 'classifier_evaluation_failed',
      );
    }
  };
}
