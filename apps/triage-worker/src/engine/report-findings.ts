import * as z from 'zod';
import type { ToolDefinition } from '@sre/agent-tools';
import {
  CAUSAL_DIRECTIONS,
  INVESTIGATION_EVIDENCE_KINDS,
  INVESTIGATION_GAP_CATEGORIES,
} from '@sre/contracts';

/**
 * The engine-local terminal tool. The model calls it exactly once to conclude the
 * investigation with a structured, Zod-validated report. It is bound like any other tool, but the
 * loop intercepts it before dispatch (so the handler below never runs) and turns its input into the
 * final `TriageResult`. A terminal tool call is the robust structured-output path: parsing JSON out
 * of free-form assistant text is brittle and leaves rankedHypotheses unpopulated. Claude is not forced
 * to call it, because Opus 5.5 rejects forced tool choice; OpenAI still names it as the tool choice.
 */
export const REPORT_FINDINGS_NAME = 'report_findings';

const SUMMARY_MAX_CHARACTERS = 4_000;

const rankedHypothesisSchema = z.object({
  hypothesis: z.string().min(1).max(1_000),
  confidence: z.number().min(0).max(100),
  evidence: z.string().max(2_000),
  state: z.enum(['leading', 'plausible', 'disfavored', 'disproven']).optional(),
  supportingEvidenceIds: z.array(z.uuid()).max(20).default([]),
  contradictingEvidenceIds: z.array(z.uuid()).max(20).default([]),
});

export const investigationGapSchema = z.object({
  question: z.string().min(1).max(1_000),
  category: z.enum(INVESTIGATION_GAP_CATEGORIES),
  evidenceKind: z.enum(INVESTIGATION_EVIDENCE_KINDS).nullable(),
  attemptedEvidenceIds: z.array(z.uuid()).max(20).default([]),
});

const causalFindingSchema = z.object({
  candidateRef: z.number().int().min(1).max(5),
  direction: z.enum(CAUSAL_DIRECTIONS),
  rationale: z.string().min(1).max(1_000),
  confidence: z.number().min(0).max(100),
  evidenceIds: z.array(z.uuid()).min(1).max(20),
});

export const reportFindingsSchema = z.object({
  outcome: z.enum(['conclusive', 'inconclusive', 'blocked_missing_capability']),
  summary: z.string().min(1).max(SUMMARY_MAX_CHARACTERS),
  confidence: z.number().min(0).max(100),
  currentState: z.string().min(1).max(500).nullable().default(null),
  impact: z.string().min(1).max(1_000).nullable().default(null),
  evidenceIds: z.array(z.uuid()).max(30).default([]),
  rankedHypotheses: z.array(rankedHypothesisSchema).max(10).default([]),
  unknowns: z.array(investigationGapSchema).max(20).default([]),
  causalFindings: z.array(causalFindingSchema).max(5).default([]),
  causeTagSuggestions: z
    .array(
      z.object({
        tag: z.string().startsWith('cause:').max(128).regex(/^\S+$/),
        evidenceIds: z.array(z.uuid()).min(1).max(20),
      }),
    )
    .max(5)
    .default([]),
  nextStep: z.string().min(1).max(2_000).nullable().default(null),
});

export type ReportFindings = z.infer<typeof reportFindingsSchema>;

export const reportFindingsTool: ToolDefinition<ReportFindings, ReportFindings> = {
  name: REPORT_FINDINGS_NAME,
  description:
    'Conclude the investigation. Choose conclusive only for a promotable assessment, inconclusive when evidence cannot support one, or blocked_missing_capability when absent platform capability is the blocking reason. Classify every remaining question as observable, partial evidence, missing capability, historical gap, contradictory evidence, or operator decision. An observable question must cite the evidence attempts made to answer it. For a supported conclusive cause, propose a short free-form cause:* tag with the data evidence receipt ids that prove it; suggestions require human acceptance.',
  inputSchema: reportFindingsSchema,
  // The loop intercepts report_findings and never dispatches it, so this handler is unreachable.
  // It exists only to satisfy the ToolDefinition contract when the tool is bound as a spec.
  async handler(_ctx, input) {
    return { available: true, data: input };
  },
};

/**
 * Parse a model-supplied report into a `ReportFindings`, defensively. The loop must always be able
 * to conclude, so this never throws: on a schema miss it salvages what it can (a usable summary if
 * present) and falls back to a low-confidence stub otherwise.
 */
export function parseReportFindings(input: unknown): ReportFindings {
  const parsed = reportFindingsSchema.safeParse(input);
  if (parsed.success) return parsed.data;

  const obj = (input ?? {}) as Record<string, unknown>;
  const summary =
    typeof obj.summary === 'string' && obj.summary.length > 0
      ? obj.summary.slice(0, SUMMARY_MAX_CHARACTERS)
      : 'No structured summary produced.';
  const confidence =
    typeof obj.confidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(obj.confidence)))
      : 30;
  return {
    outcome: 'inconclusive',
    summary,
    confidence,
    currentState: null,
    impact: null,
    evidenceIds: [],
    rankedHypotheses: [],
    unknowns: [],
    causalFindings: [],
    causeTagSuggestions: [],
    nextStep: null,
  };
}
