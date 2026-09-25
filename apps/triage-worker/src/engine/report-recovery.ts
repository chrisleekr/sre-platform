import * as z from 'zod';
import type { ToolDefinition } from '@sre/agent-tools';
import { investigationGapSchema } from './report-findings';

export const REPORT_RECOVERY_NAME = 'report_recovery';

const SUMMARY_MAX_CHARACTERS = 240;
const CHECK_NAME_MAX_CHARACTERS = 80;
const CHECK_VALUE_MAX_CHARACTERS = 120;
const EVIDENCE_MAX_ITEMS = 8;
const UNKNOWN_MAX_CHARACTERS = 240;
const UNKNOWN_MAX_ITEMS = 6;
const NEXT_STEP_MAX_CHARACTERS = 280;
const SCHEDULE_REASON_MAX_CHARACTERS = 240;
export const RECOVERY_RECHECK_MINUTES = 1;
export const RECOVERY_RECHECK_MAX_MINUTES = 60;

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/[\r\n]/u.test(value), 'must be a single line');

const recoveryCheckSchema = z.object({
  name: singleLine(CHECK_NAME_MAX_CHARACTERS),
  before: singleLine(CHECK_VALUE_MAX_CHARACTERS).nullable(),
  now: singleLine(CHECK_VALUE_MAX_CHARACTERS),
});

const legacyReportRecoverySchema = z
  .object({
    outcome: z.enum(['recovered', 'recheck', 'needs_human']).optional(),
    // Accepted for existing deterministic engines while providers migrate to the tri-state outcome.
    recovered: z.boolean().optional(),
    summary: singleLine(SUMMARY_MAX_CHARACTERS),
    evidence: z.array(recoveryCheckSchema).max(EVIDENCE_MAX_ITEMS).default([]),
    evidenceIds: z.array(z.uuid()).max(EVIDENCE_MAX_ITEMS).default([]),
    unknowns: z.array(singleLine(UNKNOWN_MAX_CHARACTERS)).max(UNKNOWN_MAX_ITEMS).default([]),
    nextStep: singleLine(NEXT_STEP_MAX_CHARACTERS).nullable().default(null),
    recheckAfterMinutes: z
      .number()
      .int()
      .min(RECOVERY_RECHECK_MINUTES)
      .max(RECOVERY_RECHECK_MAX_MINUTES)
      .nullable()
      .default(null),
    scheduleReason: singleLine(SCHEDULE_REASON_MAX_CHARACTERS).nullable().default(null),
  })
  .superRefine((report, ctx) => {
    const outcome = report.outcome ?? (report.recovered === true ? 'recovered' : 'needs_human');
    if (report.outcome && report.recovered !== undefined) {
      const consistent = report.recovered === (report.outcome === 'recovered');
      if (!consistent) {
        ctx.addIssue({
          code: 'custom',
          path: ['recovered'],
          message: 'recovery outcome conflicts',
        });
      }
    }
    if (
      (outcome === 'recovered' || outcome === 'recheck') &&
      (report.evidence.length === 0 || report.evidenceIds.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'recovery decisions require current factual evidence',
      });
    }
    if (outcome === 'recheck' && (!report.recheckAfterMinutes || !report.scheduleReason)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recheckAfterMinutes'],
        message: 'recheck requires a delay and reason',
      });
    }
    if (
      outcome !== 'recheck' &&
      (report.recheckAfterMinutes !== null || report.scheduleReason !== null)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'only recheck may schedule work',
      });
    }
  });

export const recoveryQuestionSchema = investigationGapSchema.extend({
  question: singleLine(UNKNOWN_MAX_CHARACTERS),
  attemptedEvidenceIds: z.array(z.uuid()).max(20),
  resolutionRelevance: z.enum(['blocking', 'follow_up']),
  nextAction: singleLine(NEXT_STEP_MAX_CHARACTERS),
});

export const reportRecoverySchema = legacyReportRecoverySchema
  .safeExtend({
    questions: z.array(recoveryQuestionSchema).max(UNKNOWN_MAX_ITEMS),
  })
  .superRefine((report, ctx) => {
    const outcome = report.outcome ?? (report.recovered === true ? 'recovered' : 'needs_human');
    const hasBlocker = report.questions.some(
      (question) => question.resolutionRelevance === 'blocking',
    );
    if ((outcome === 'needs_human' && !hasBlocker) || (outcome === 'recovered' && hasBlocker)) {
      ctx.addIssue({
        code: 'custom',
        path: ['questions'],
        message:
          outcome === 'recovered'
            ? 'recovered cannot retain resolution blockers'
            : 'needs_human requires an actionable resolution blocker',
      });
    }
  });

type ReportRecoveryInput = z.infer<typeof reportRecoverySchema>;
type LegacyReportRecoveryInput = z.infer<typeof legacyReportRecoverySchema>;
export type ReportRecovery = Omit<LegacyReportRecoveryInput, 'outcome' | 'recovered'> & {
  questions?: ReportRecoveryInput['questions'];
} & {
  outcome: 'recovered' | 'recheck' | 'needs_human';
  recovered: boolean;
};

function normalizeReportRecovery(
  report: LegacyReportRecoveryInput & { questions?: ReportRecoveryInput['questions'] },
): ReportRecovery {
  const outcome = report.outcome ?? (report.recovered === true ? 'recovered' : 'needs_human');
  return {
    ...report,
    ...(report.questions !== undefined
      ? { unknowns: report.questions.map((question) => question.question) }
      : {}),
    outcome,
    recovered: outcome === 'recovered',
  };
}

export const reportRecoveryTool: ToolDefinition<ReportRecoveryInput, ReportRecovery> = {
  name: REPORT_RECOVERY_NAME,
  description:
    'Conclude recovery verification with outcome recovered, recheck, or needs_human. Choose recheck and a 1-60 minute delay when current evidence shows a bounded transient condition worth monitoring automatically. Choose needs_human when waiting is unsafe or evidence is unavailable. Recovered and recheck require current cited evidence. Name the affected resource and the configured recovery criterion or observation window when known; never invent them. Classify questions as blocking current resolution or follow_up prevention work, with an explicit nextAction and actual attemptedEvidenceIds. needs_human requires a blocker; recovered forbids blockers. Empty attempts mean no check was possible, never health proof. Unknown cause or recurrence risk alone is follow-up work. Keep the summary and scheduling reason direct.',
  inputSchema: reportRecoverySchema,
  async handler(_ctx, input) {
    return { available: true, data: normalizeReportRecovery(input) };
  },
};

export function parseReportRecovery(input: unknown): ReportRecovery {
  const schema =
    input && typeof input === 'object' && Object.hasOwn(input, 'questions')
      ? reportRecoverySchema
      : legacyReportRecoverySchema;
  const parsed = schema.safeParse(input);
  if (parsed.success) return normalizeReportRecovery(parsed.data);
  return {
    outcome: 'needs_human',
    recovered: false,
    summary: 'Recovery could not be verified.',
    evidence: [],
    evidenceIds: [],
    unknowns: ['The engine did not produce a valid recovery report.'],
    nextStep: 'Verify current service health manually.',
    recheckAfterMinutes: null,
    scheduleReason: null,
  };
}
