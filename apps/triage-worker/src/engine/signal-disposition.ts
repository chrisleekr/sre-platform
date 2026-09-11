import * as z from 'zod';
import { scrubSecrets } from '@sre/agent-tools';
import { createHash } from 'node:crypto';
import { SEMANTIC_DISPOSITION_CONTRACT_VERSION } from '@sre/contracts';
/** Bumped whenever deterministic semantic-result safety or routing behavior changes. */
export const SEMANTIC_DISPOSITION_BEHAVIOR_VERSION = '4';

const correlationFields = {
  decision: z.enum(['standalone', 'belongs_to', 'resolves_signal', 'new_incident']),
  index: z.number().int().positive().optional(),
  signalIndex: z.number().int().positive().optional(),
};

const baseFields = {
  reason: z.string().min(1).max(1_000),
  service: z.string().min(1).max(200).optional(),
  severity: z.enum(['sev1', 'sev2', 'sev3']).optional(),
  title: z.string().min(1).max(200).optional(),
  ...correlationFields,
};

/** Structured semantic disposition returned by the bounded classifier operation. */
export const semanticDispositionSchema = z
  .discriminatedUnion('disposition', [
    z.object({ disposition: z.literal('investigate'), ...baseFields }),
    z.object({
      disposition: z.literal('ticket'),
      ...baseFields,
      action: z.string().min(1).max(2_000),
      safeDeferralReason: z.string().min(1).max(2_000),
      riskIfIgnored: z.string().min(1).max(2_000),
      reviewHorizonMinutes: z.number().int().min(1).max(10_080),
    }),
    z.object({ disposition: z.literal('log'), ...baseFields }),
  ])
  .superRefine((value, context) => {
    const needsIncidentIndex = value.decision === 'belongs_to';
    const needsSignalIndex = value.decision === 'resolves_signal';
    if (needsIncidentIndex !== (value.index !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['index'],
        message: 'belongs_to requires exactly one incident index',
      });
    }
    if (needsSignalIndex !== (value.signalIndex !== undefined)) {
      context.addIssue({
        code: 'custom',
        path: ['signalIndex'],
        message: 'resolves_signal requires exactly one unresolved-signal index',
      });
    }
    if (needsSignalIndex && value.disposition !== 'log') {
      context.addIssue({
        code: 'custom',
        path: ['disposition'],
        message: 'a recovery updates durable state without opening new work',
      });
    }
  });

export type SemanticDisposition = z.infer<typeof semanticDispositionSchema>;

export interface DurableSignalContext {
  signalId: string;
  jobId: string;
  summary: string;
  source: string;
  author: string;
  service: string | null;
  signalState: string;
  correlationCandidates?: Array<{ index: number; title: string; service: string }>;
  resolutionCandidates?: Array<{
    index: number;
    title: string;
    service: string;
    summary: string;
  }>;
}

interface SemanticGenerator {
  generate(request: Record<string, unknown>, system: string): Promise<unknown>;
}

/** Trusted policy instruction for the semantic signal decision. */
export const SEMANTIC_DISPOSITION_RUBRIC = [
  'Classify this durable, scrubbed operational signal.',
  'investigate: urgent, actionable, and actively or imminently user-visible harm needs diagnosis now.',
  'ticket: a real reliability risk is safely deferrable, including uncertain or ambiguous impact.',
  'log: useful context with no reliability action required.',
  'Disposition is independent from correlation. Use belongs_to only with a supplied incident index.',
  'Use resolves_signal only when this message clearly recovers exactly one supplied unresolved signal.',
  'Never treat possible data loss, security harm, or broad active failure as safely deferrable.',
].join('\n');

function scrubSemanticOutput(value: SemanticDisposition): SemanticDisposition {
  const common = {
    ...value,
    reason: scrubSecrets(value.reason),
    ...(value.service ? { service: scrubSecrets(value.service) } : {}),
    ...(value.title ? { title: scrubSecrets(value.title) } : {}),
  };
  return value.disposition === 'ticket'
    ? {
        ...common,
        disposition: 'ticket',
        action: scrubSecrets(value.action),
        safeDeferralReason: scrubSecrets(value.safeDeferralReason),
        riskIfIgnored: scrubSecrets(value.riskIfIgnored),
        reviewHorizonMinutes: value.reviewHorizonMinutes,
      }
    : common;
}

/**
 * Executes one tool-free semantic classification over durable scrubbed context.
 * @param context - Durable signal fields, excluding provider payloads.
 * @param generator - Structured generation seam.
 */
export async function classifyDurableSignal(
  context: DurableSignalContext,
  generator: SemanticGenerator,
): Promise<SemanticDisposition> {
  const request = {
    context: {
      signalRef: createHash('sha256').update(context.signalId).digest('hex'),
      jobRef: createHash('sha256').update(context.jobId).digest('hex'),
      summary: scrubSecrets(context.summary),
      source: context.source,
      author: context.author,
      service: context.service ? scrubSecrets(context.service) : null,
      signalState: context.signalState,
      correlationCandidates: (context.correlationCandidates ?? []).map((candidate) => ({
        index: candidate.index,
        title: scrubSecrets(candidate.title),
        service: scrubSecrets(candidate.service),
      })),
      resolutionCandidates: (context.resolutionCandidates ?? []).map((candidate) => ({
        index: candidate.index,
        title: scrubSecrets(candidate.title),
        service: scrubSecrets(candidate.service),
        summary: scrubSecrets(candidate.summary),
      })),
    },
    schema: SEMANTIC_DISPOSITION_CONTRACT_VERSION,
  };
  const parsed = semanticDispositionSchema.parse(
    await generator.generate(request, SEMANTIC_DISPOSITION_RUBRIC),
  );
  if (parsed.decision === 'resolves_signal' && context.signalState !== 'resolved') {
    throw new Error('only a provider recovery can resolve a durable signal');
  }
  if (
    context.author === 'provider' &&
    context.signalState === 'firing' &&
    parsed.disposition === 'log'
  ) {
    return scrubSemanticOutput({
      disposition: 'ticket',
      decision: parsed.decision === 'belongs_to' ? 'belongs_to' : 'standalone',
      ...(parsed.index === undefined ? {} : { index: parsed.index }),
      reason: 'An active provider signal requires human review before suppression.',
      service: parsed.service,
      severity: parsed.severity,
      title: parsed.title,
      action: 'Confirm whether this firing signal is expected or requires investigation.',
      safeDeferralReason: 'No urgent user-visible harm was established by the classifier.',
      riskIfIgnored: 'A real active failure may otherwise be silently suppressed.',
      reviewHorizonMinutes: 60,
    });
  }
  return scrubSemanticOutput(parsed);
}

export interface CorpusScenario {
  id: string;
  message: string;
  expected: 'investigate' | 'ticket' | 'log';
  criticalSafety: boolean;
  expectedDecision: {
    decision: SemanticDisposition['decision'];
    index?: number;
    signalIndex?: number;
  };
  ticket?: {
    action: string;
    safeDeferralReason: string;
    riskIfIgnored: string;
    reviewHorizonMinutes: number;
  };
}

export interface CorpusPrediction {
  disposition: string;
  decision?: string;
  index?: number;
  signalIndex?: number;
  action?: string;
  safeDeferralReason?: string;
  riskIfIgnored?: string;
  reviewHorizonMinutes?: number;
}

export interface DispositionScenarioResult {
  id: string;
  message: string;
  expected: CorpusScenario['expected'];
  criticalSafety: boolean;
  expectedDecision: CorpusScenario['expectedDecision'];
  expectedTicket: CorpusScenario['ticket'] | null;
  prediction: CorpusPrediction | null;
  routingCorrect: boolean;
  ticketStructureCorrect: boolean;
}

export interface DispositionCorpusScore {
  total: number;
  correct: number;
  criticalSafetyMisses: number;
  classMetrics: Record<
    'investigate' | 'ticket' | 'log',
    { expected: number; predicted: number; correct: number; recall: number; precision: number }
  >;
  scenarioResults: DispositionScenarioResult[];
  ticketScenarioIds: string[];
}

/**
 * Scores a frozen corpus without inventing a product-wide accuracy threshold.
 * @param scenarios - Frozen reviewed scenarios.
 * @param predictions - Predicted class keyed by scenario id.
 */
export function scoreSignalDispositionCorpus(
  scenarios: readonly CorpusScenario[],
  predictions: ReadonlyMap<string, CorpusPrediction>,
): DispositionCorpusScore {
  const classes = ['investigate', 'ticket', 'log'] as const;
  const classMetrics = Object.fromEntries(
    classes.map((name) => [
      name,
      { expected: 0, predicted: 0, correct: 0, recall: 0, precision: 0 },
    ]),
  ) as DispositionCorpusScore['classMetrics'];
  let correct = 0;
  let criticalSafetyMisses = 0;
  const scenarioResults: DispositionScenarioResult[] = [];
  for (const scenario of scenarios) {
    const predicted = predictions.get(scenario.id);
    classMetrics[scenario.expected].expected += 1;
    if (predicted && classes.includes(predicted.disposition as (typeof classes)[number])) {
      classMetrics[predicted.disposition as (typeof classes)[number]].predicted += 1;
    }
    const routingCorrect =
      predicted?.decision === scenario.expectedDecision.decision &&
      predicted.index === scenario.expectedDecision.index &&
      predicted.signalIndex === scenario.expectedDecision.signalIndex;
    const ticketContractCorrect =
      scenario.expected !== 'ticket' ||
      (typeof predicted?.action === 'string' &&
        predicted.action.trim().length > 0 &&
        typeof predicted.safeDeferralReason === 'string' &&
        predicted.safeDeferralReason.trim().length > 0 &&
        typeof predicted.riskIfIgnored === 'string' &&
        predicted.riskIfIgnored.trim().length > 0 &&
        typeof predicted.reviewHorizonMinutes === 'number' &&
        Number.isInteger(predicted.reviewHorizonMinutes) &&
        predicted.reviewHorizonMinutes >= 1 &&
        predicted.reviewHorizonMinutes <= scenario.ticket!.reviewHorizonMinutes);
    scenarioResults.push({
      id: scenario.id,
      message: scenario.message,
      expected: scenario.expected,
      criticalSafety: scenario.criticalSafety,
      expectedDecision: scenario.expectedDecision,
      expectedTicket: scenario.ticket ?? null,
      prediction: predicted ?? null,
      routingCorrect,
      ticketStructureCorrect: ticketContractCorrect,
    });
    if (predicted?.disposition === scenario.expected && routingCorrect && ticketContractCorrect) {
      correct += 1;
      classMetrics[scenario.expected].correct += 1;
    } else if (scenario.criticalSafety) {
      criticalSafetyMisses += 1;
    }
  }
  for (const name of classes) {
    const metric = classMetrics[name];
    metric.recall = metric.expected === 0 ? 0 : metric.correct / metric.expected;
    metric.precision = metric.predicted === 0 ? 0 : metric.correct / metric.predicted;
  }
  return {
    total: scenarios.length,
    correct,
    criticalSafetyMisses,
    classMetrics,
    scenarioResults,
    ticketScenarioIds: scenarios
      .filter((scenario) => scenario.expected === 'ticket')
      .map((scenario) => scenario.id),
  };
}

/**
 * Applies the reviewed safety and operator-approval enforcement gate.
 * @param input - Corpus score and audited approval.
 */
export function semanticDispositionGate(input: {
  score: DispositionCorpusScore;
  operatorApproval: {
    approved: boolean;
    actor: string;
    reviewedTicketScenarioIds: string[];
  } | null;
}): { enforce: boolean; reason: string } {
  if (input.score.criticalSafetyMisses > 0)
    return { enforce: false, reason: 'critical_safety_miss' };
  if (input.score.correct !== input.score.total) return { enforce: false, reason: 'corpus_miss' };
  if (!input.operatorApproval?.approved)
    return { enforce: false, reason: 'operator_approval_required' };
  const reviewed = new Set(input.operatorApproval.reviewedTicketScenarioIds);
  if (
    reviewed.size !== input.score.ticketScenarioIds.length ||
    input.score.ticketScenarioIds.some((id) => !reviewed.has(id))
  )
    return { enforce: false, reason: 'ticket_semantics_review_required' };
  return { enforce: true, reason: 'approved' };
}
