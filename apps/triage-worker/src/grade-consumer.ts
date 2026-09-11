import * as z from 'zod';
import { ASSESSMENT_VERDICTS, type PostmortemDetail } from '@sre/contracts';
import {
  getInvestigationRunById,
  getPostmortemDetail,
  listTenantMembers,
  upsertModelAssessmentGradeTx,
  withTenant,
  type Db,
  type ModelGradeInput,
} from '@sre/db';
import { RetryableError, type Job, type JobContext } from '@sre/queue';
import { collectHumanIdentifiers, stripHumanIdentifiers } from './blameless';
import { ProviderUnavailableError, type StructuredGenerator } from './engine/types';
import type { LlmRuntimeManager } from './llm-runtime';
import { publicModelText } from './public-output';

// Bounded redelivery on a provider outage, then give up silently: nobody asked for a grade in the
// thread, so a "grading failed" line would be toil the platform created.
const FAIL_MAX = 5;

const GradeSchema = z.object({
  verdict: z.enum(ASSESSMENT_VERDICTS),
  rationale: z.string(),
});

export interface GradedRun {
  id: string;
  incidentId: string;
  result: Record<string, unknown> | null;
}

type GetDetailFn = (tenantId: string, incidentId: string) => Promise<PostmortemDetail | null>;
type GetRunFn = (tenantId: string, runId: string) => Promise<GradedRun | null>;
type UpsertGradeFn = (tenantId: string, input: ModelGradeInput) => Promise<boolean>;
type ListMemberEmailsFn = (tenantId: string) => Promise<string[]>;

export interface GradeHandlerDeps {
  llm?: LlmRuntimeManager;
  generator?: StructuredGenerator;
  appDb: Db;
  // Injectable, default to @sre/db bound to appDb. Tests inject spies to stay hermetic.
  getPostmortemDetail?: GetDetailFn;
  getInvestigationRunById?: GetRunFn;
  upsertModelGrade?: UpsertGradeFn;
  listMemberEmails?: ListMemberEmailsFn;
}

interface Claim {
  summary: string;
  topHypothesis: string | null;
  confidence: number;
}

function readClaim(run: GradedRun): Claim | null {
  const result = run.result ?? {};
  const confidence = result.confidence;
  if (typeof confidence !== 'number') return null;
  const ranked = Array.isArray(result.rankedHypotheses) ? result.rankedHypotheses : [];
  const top = ranked[0] as { hypothesis?: unknown } | undefined;
  return {
    summary: typeof result.summary === 'string' ? result.summary : '',
    topHypothesis: typeof top?.hypothesis === 'string' ? top.hypothesis : null,
    confidence,
  };
}

function buildPrompt(claim: Claim, detail: PostmortemDetail): string {
  const { postmortem } = detail;
  return [
    'Grade an automated root-cause assessment against the published postmortem, the ground truth',
    'reviewed by the responders. correct: the assessment named the contributing cause the postmortem',
    'records. partial: it named a real contributing factor but missed or misattributed the main cause.',
    'incorrect: it named a cause the postmortem does not support. Explain briefly.',
    '',
    `Assessment summary: ${claim.summary || '(none)'}`,
    `Assessment top hypothesis: ${claim.topHypothesis ?? '(none)'}`,
    `Assessment claimed confidence: ${claim.confidence}`,
    '',
    `Postmortem contributing causes: ${JSON.stringify(postmortem.contributingCauses.map((c) => c.cause))}`,
    `Postmortem resolution: ${postmortem.resolution}`,
    `Postmortem summary: ${postmortem.summary}`,
  ].join('\n');
}

/**
 * Assessment-grade consumer on the `sre:runbook` stream. Runs only for a published postmortem
 * and a pinned run that claimed a confidence; one StructuredGenerator call judges the run's summary
 * and top hypothesis against the postmortem's contributing causes, then the model verdict is
 * upserted without touching any human verdict. The rationale passes the same identifier guard as
 * generated postmortems before storage. On failure it retries boundedly and then stops: no hub
 * post, no incident change, and one structured warn line so the lost grade is visible to operators.
 */
export function makeGradeHandler(
  deps: GradeHandlerDeps,
): (job: Job, ctx?: JobContext) => Promise<void> {
  const { appDb, generator } = deps;
  const getDetail: GetDetailFn =
    deps.getPostmortemDetail ??
    ((tenantId, incidentId) => getPostmortemDetail(appDb, tenantId, incidentId));
  const getRun: GetRunFn =
    deps.getInvestigationRunById ??
    ((tenantId, runId) => getInvestigationRunById(appDb, tenantId, runId));
  const upsert: UpsertGradeFn =
    deps.upsertModelGrade ??
    ((tenantId, input) =>
      withTenant(appDb, tenantId, (tx) => upsertModelAssessmentGradeTx(tx, tenantId, input)));
  const listEmails: ListMemberEmailsFn =
    deps.listMemberEmails ??
    (async (tenantId) =>
      (await listTenantMembers(appDb, tenantId))
        .map((member) => member.email)
        .filter((email): email is string => typeof email === 'string'));

  return async (
    job: Job,
    ctx: JobContext = { signal: new AbortController().signal },
  ): Promise<void> => {
    if (job.type !== 'assessment.grade') return;
    const { incidentId, runId } = job.payload as { incidentId: string; runId: string };
    const tenantId = job.tenantId;
    const { signal } = ctx;

    const detail = await getDetail(tenantId, incidentId);
    if (!detail || detail.postmortem.status !== 'published') return;
    const run = await getRun(tenantId, runId);
    if (!run || run.incidentId !== incidentId) return;
    const claim = readClaim(run);
    if (!claim) return; // no confidence was claimed, so there is nothing to falsify

    const prompt = buildPrompt(claim, detail);
    let grade: z.infer<typeof GradeSchema>;
    try {
      if (deps.llm) {
        grade = await deps.llm.execute(
          { tenantId, incidentId, jobId: job.id, operation: 'assessment-grade', signal },
          ({ generator: current }) => current.generate(prompt, GradeSchema, { signal }),
        );
      } else {
        if (!generator) throw new Error('assessment grader is not configured');
        grade = await generator.generate(prompt, GradeSchema, { signal });
      }
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      if (err instanceof ProviderUnavailableError && job.attempts < FAIL_MAX) {
        throw new RetryableError('assessment grading provider unavailable');
      }
      // Terminal: ack with never a hub post, but an operator must be able to see a lost grade.
      // Name only: a parse error's message can embed raw model text.
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'assessment_grade.abandoned',
          jobId: job.id,
          incidentId,
          runId,
          error: err instanceof Error ? err.name : 'unknown',
        }),
      );
      return;
    }
    // The prompt carries the run's own summary, which can name people; the judge must not repeat them.
    const identifiers = collectHumanIdentifiers(await listEmails(tenantId), prompt);
    await upsert(tenantId, {
      incidentId,
      runId,
      verdict: grade.verdict,
      rationale: stripHumanIdentifiers(publicModelText(grade.rationale), identifiers),
    });
  };
}
