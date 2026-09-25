import type { ZodType } from 'zod';
import { parseStructuredOutput } from './structured-repair';
import type {
  RecoveryInput,
  ResumeInput,
  StructuredGenerationOptions,
  StructuredGenerator,
  TriageEngine,
  TriageInput,
  TriageResult,
  TriageRuntime,
  VisionModel,
} from './types';

/**
 * Deterministic engine for dev and tests. It performs no LLM call; it streams a fixed-shape
 * investigation through `runtime.onStep` so the worker's orchestration (status, hub transcript,
 * RCA persistence) can be exercised end to end without a provider.
 */
export function makeFakeEngine(): TriageEngine {
  return {
    provider: 'fake',
    async investigate(input: TriageInput, runtime: TriageRuntime): Promise<TriageResult> {
      const { id, service } = input.incident;
      // Stream an intermediate step; the concluding finding is appended by the worker from the
      // returned disposition, so the fake no longer streams it.
      await runtime.onStep('tool_step', `Fetched recent context for ${service}.`);
      return {
        provider: 'fake',
        sessionId: `fake:${id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 0,
        evidenceReceipts: [],
        disposition: 'rca',
        summary: `Likely a recent change to ${service}; recommend reviewing the latest deploy.`,
        confidence: 50,
        rankedHypotheses: [
          {
            hypothesis: `Recent deploy to ${service} introduced a regression.`,
            confidence: 50,
            evidence: `Alert on ${service} correlates with a deploy window.`,
          },
        ],
      };
    },
    async resume(input: ResumeInput): Promise<TriageResult> {
      const { id, service } = input.incident;
      // The worker appends the concluding finding from `summary`, so thread the human reply into it.
      return {
        provider: 'fake',
        sessionId: `fake:${id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 0,
        evidenceReceipts: [],
        disposition: 'rca',
        summary: `After the human reply, still likely a recent change to ${service}: ${input.humanMessage}`,
        confidence: 55,
        rankedHypotheses: [
          {
            hypothesis: `Recent deploy to ${service} introduced a regression.`,
            confidence: 55,
            evidence: `Human reply: ${input.humanMessage}`,
          },
        ],
      };
    },
    async verifyRecovery(input: RecoveryInput, runtime: TriageRuntime): Promise<TriageResult> {
      const evidenceId = await runtime.ctx.audit.record({
        tenantId: runtime.ctx.tenantId,
        incidentId: input.incident.id,
        tool: 'fake_current_health',
        input: { service: input.incident.service },
        output: { healthy: true, source: 'fake' },
        latencyMs: 0,
        outcome: 'data',
      });
      return {
        provider: 'fake',
        sessionId: `fake:${input.incident.id}`,
        model: 'fake',
        outcome: 'conclusive',
        turnBudget: 0,
        evidenceReceipts: [{ evidenceId, tool: 'fake_recovery_check', outcome: 'complete' }],
        disposition: 'recovery',
        summary: `Fake health checks confirm ${input.incident.service} has recovered.`,
        confidence: 0,
        rankedHypotheses: [],
        recovery: {
          recovered: true,
          evidence: [
            {
              name: 'Current health',
              before: 'alert firing',
              now: `${input.incident.service} health check passed`,
            },
          ],
          evidenceIds: [evidenceId],
          unknowns: [],
          nextStep: null,
        },
      };
    },
  };
}

/**
 * Deterministic `StructuredGenerator` for dev and tests. Makes no LLM call: it runs the optional
 * `script` (keyed on the prompt) to produce a value, then validates it against the caller's schema so
 * a scripted output must still satisfy the domain contract. Unscripted it parses `{}`, which fails
 * for any non-trivial schema — a clear signal that fake structured generation needs a script.
 */
export function makeFakeGenerator(script?: (prompt: string) => unknown): StructuredGenerator {
  return {
    async generate<T>(
      prompt: string,
      schema: ZodType<T>,
      options?: StructuredGenerationOptions,
    ): Promise<T> {
      return parseStructuredOutput(schema, script ? script(prompt) : {}, options);
    },
  };
}

/**
 * Deterministic `VisionModel` for dev and tests. Makes no LLM call: returns a fixed factual line so
 * the worker's interpret-at-turn path is exercised end to end without a provider. Vision-capable by
 * default so the happy path runs; pass `supportsVision: false` to drive the `VisionUnsupported` path.
 */
export function makeFakeVision(supportsVision = true): VisionModel {
  return {
    provider: 'fake',
    supportsVision,
    async describeImage(
      _bytes,
      mime,
      _prompt,
      _options?: { signal?: AbortSignal },
    ): Promise<string> {
      return `fake interpretation of a ${mime} image`;
    },
  };
}
