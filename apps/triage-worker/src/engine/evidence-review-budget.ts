import { ZodError, type infer as Infer, type ZodType } from 'zod';
import { ProviderRateLimitError } from './types';
import { parseWithLengthRepair } from './structured-repair';
import {
  evidenceSliceSchema,
  EVIDENCE_SLICE_INSTRUCTION,
  EvidenceReviewFailure,
  reviewValidationFailure,
  type ReviewStage,
} from './evidence-review-contracts';
export { EvidenceReviewFailure } from './evidence-review-contracts';
import type { reportRecoverySchema } from './report-recovery';
import type {
  InvestigationEvidence,
  ResumeInput,
  StructuredGenerator,
  TriageInput,
  TriageResult,
} from './types';
import { ELISION_MARKER, transcriptBudgetChars } from '../worker/transcript';

interface Review {
  correctedRecovery?: Infer<typeof reportRecoverySchema>;
  supported: boolean;
  rejection?: 'insufficient_evidence' | 'contradictory_evidence' | 'missing_capability';
  summary: string;
  detail?: string;
  gaps?: string[];
  nextStep?: string;
  evidenceIds: string[];
}

interface Slice {
  evidenceId: string;
  offset: number;
  endOffset: number;
  totalLength: number;
  content: string;
}

/** Cover each serialized record exactly once before allowing synthesis. `unreviewedIds` names the
 * admitted records left out when a budget failure fell back to the cited subset, so the caller can
 * record that the review was partial.
 * @param generator - Existing structured provider boundary.
 * @param schema - Review response contract.
 * @param instruction - Evidence and temporal safety instructions.
 * @param candidate - Answer awaiting review.
 * @param evidence - Admitted durable evidence.
 * @param signal - Shared investigation deadline.
 * @param task - Original responder request.
 */
export async function boundedEvidenceReview(
  generator: StructuredGenerator,
  schema: ZodType<Review>,
  instruction: string,
  candidate: TriageResult,
  evidence: InvestigationEvidence[],
  signal: AbortSignal,
  task?: TriageInput,
): Promise<{ review: Review; unreviewedIds: string[] }> {
  if (evidence.some((record) => !record.id))
    throw new EvidenceReviewFailure(
      'Evidence review record is missing an id; coverage is incomplete.',
    );
  const review = (records: InvestigationEvidence[], scope: string) =>
    reviewRecords(generator, schema, instruction, candidate, records, signal, task, scope);
  try {
    return { review: await review(evidence, ''), unreviewedIds: [] };
  } catch (error) {
    if (!(error instanceof EvidenceReviewFailure) || error.kind !== 'budget') throw error;
    // Partial coverage must never authorize resolution, so recovery verification fails closed.
    if (candidate.disposition === 'recovery') throw error;
    // For assessments and replies the reviewer's own limits are not evidence against the
    // conclusion. Review the records it relies on instead, and say uncited output was not reviewed.
    const cited = citedEvidenceIds(candidate);
    const subset = evidence.filter((record) => cited.has(record.id!));
    if (subset.length === 0 || subset.length === evidence.length) throw error;
    return {
      review: await review(subset, `${CITED_COVERAGE} `),
      unreviewedIds: evidence.flatMap((record) => (cited.has(record.id!) ? [] : [record.id!])),
    };
  }
}

const CITED_COVERAGE =
  'Only the records this conclusion cites. Uncited run output was not reviewed; its absence proves nothing.';

/** Evidence the candidate relies on, including records its hypotheses say contradict it. */
export function citedEvidenceIds(candidate: TriageResult): Set<string> {
  return new Set([
    ...(candidate.evidenceIds ?? []),
    ...(candidate.recovery?.evidenceIds ?? []),
    ...(candidate.causalFindings ?? []).flatMap((finding) => finding.evidenceIds),
    ...(candidate.rankedHypotheses ?? []).flatMap((hypothesis) => [
      ...(hypothesis.supportingEvidenceIds ?? []),
      ...(hypothesis.contradictingEvidenceIds ?? []),
    ]),
  ]);
}

// The history is repeated in every 96,000-character chunk prompt, so an operator-raised transcript
// budget must not crowd out the records.
const REVIEWER_PRIOR_MAX_CHARS = 32_000;

/**
 * The reviewer judges the admitted records, so the tool steps that produced them are dropped rather
 * than repeated in every chunk, and older messages give way to the newest within the transcript budget.
 */
function reviewerPrior(prior: ResumeInput['prior']): ResumeInput['prior'] {
  const isMarker = (message: ResumeInput['prior'][number]) =>
    message.author === ELISION_MARKER.author && message.content === ELISION_MARKER.content;
  const messages = prior.filter((message) => message.kind !== 'tool_step');
  // splitResumeInput pins the opener ahead of its marker; the opener survives the trim and an existing
  // marker is neither charged to the budget nor repeated.
  const pinned =
    messages.length > 1 && !isMarker(messages[0]!) && isMarker(messages[1]!) ? [messages[0]!] : [];
  const rest = messages.slice(pinned.length).filter((message) => !isMarker(message));
  let remaining =
    Math.min(transcriptBudgetChars(), REVIEWER_PRIOR_MAX_CHARS) - (pinned[0]?.content.length ?? 0);
  let start = rest.length;
  while (start > 0 && rest[start - 1]!.content.length <= remaining)
    remaining -= rest[--start]!.content.length;
  const elided = start > 0 || messages.length > pinned.length + rest.length;
  return [...pinned, ...(elided ? [{ ...ELISION_MARKER }] : []), ...rest.slice(start)];
}

/** Review one record set; `scope` prefixes every coverage statement the reviewer sees. */
async function reviewRecords(
  generator: StructuredGenerator,
  schema: ZodType<Review>,
  instruction: string,
  candidate: TriageResult,
  evidence: InvestigationEvidence[],
  signal: AbortSignal,
  task: TriageInput | undefined,
  scope: string,
): Promise<Review> {
  const context = {
    task: task
      ? {
          ...task,
          evidence: undefined,
          ...('prior' in task && Array.isArray(task.prior)
            ? { prior: reviewerPrior(task.prior) }
            : {}),
        }
      : undefined,
    candidate,
  };
  const allowed = new Set(evidence.flatMap((record) => (record.id ? [record.id] : [])));
  const generate = async <T>(
    value: unknown,
    cap: number,
    stage: ReviewStage,
    responseSchema: ZodType<T>,
  ): Promise<T> => {
    signal.throwIfAborted();
    const prompt = JSON.stringify(value);
    if (prompt.length > cap)
      throw new EvidenceReviewFailure(
        `Evidence review ${stage} input budget exceeded (${prompt.length} > ${cap}); coverage is incomplete.`,
      );
    try {
      // A reviewer note or corrected field longer than its limit is trimmed, not treated as a failed
      // review: the length says nothing about whether the evidence supports the conclusion.
      const review = parseWithLengthRepair(
        responseSchema,
        await generator.generate(prompt, responseSchema, {
          signal,
          system: stage === 'slice' ? EVIDENCE_SLICE_INSTRUCTION : instruction,
          repairOverlength: true,
        }),
      );
      signal.throwIfAborted();
      return review;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof ProviderRateLimitError) throw error;
      if (error instanceof ZodError) throw reviewValidationFailure(error, stage);
      throw new EvidenceReviewFailure(
        error instanceof Error && error.name === 'TimeoutError'
          ? `Evidence review ${stage} timed out; coverage is incomplete.`
          : `Evidence review ${stage} provider was unavailable; coverage is incomplete.`,
        'provider',
      );
    }
  };
  const finalReview = async (value: unknown, cap: number, stage: 'single' | 'synthesis') => {
    const review = await generate(value, cap, stage, schema);
    if (
      [
        ...review.evidenceIds,
        ...(review.correctedRecovery?.evidenceIds ?? []),
        ...(review.correctedRecovery?.questions.flatMap(
          (question) => question.attemptedEvidenceIds,
        ) ?? []),
      ].some((id) => !allowed.has(id))
    )
      throw new EvidenceReviewFailure(
        `Evidence review ${stage} cited foreign or unadmitted evidence.`,
        'validation',
      );
    return review;
  };
  const single = {
    ...context,
    evidence,
    coverage: `${scope}Bounded records, not proof of historical absence`,
  };
  if (JSON.stringify(single).length <= 160_000) return finalReview(single, 160_000, 'single');

  const records = evidence.map((record) => ({
    id: record.id,
    content: JSON.stringify(record),
  }));
  if (records.reduce((total, record) => total + record.content.length, 0) > 480_000)
    throw new EvidenceReviewFailure(
      'Evidence review input budget exceeded; coverage is incomplete.',
    );
  const chunkInput = (slices: Slice[]) => ({
    ...context,
    evidenceSlices: slices,
    coverage: `${scope}Partial record slices; offsets are half-open serialized-record character ranges.`,
  });
  const fits = (slices: Slice[]) => JSON.stringify(chunkInput(slices)).length <= 96_000;
  if (!fits([]))
    throw new EvidenceReviewFailure('Evidence review context exceeds the chunk input budget.');
  const chunks: Slice[][] = [];
  let chunk: Slice[] = [];
  for (const record of records) {
    for (let offset = 0; offset < record.content.length;) {
      signal.throwIfAborted();
      if (chunks.length === 6)
        throw new EvidenceReviewFailure(
          `Evidence review chunk budget exceeded; repeated context uses ${JSON.stringify(context).length} characters of each 96,000-character prompt. Coverage is incomplete.`,
        );
      const slice = (endOffset: number): Slice => ({
        evidenceId: record.id!,
        offset,
        endOffset,
        totalLength: record.content.length,
        content: record.content.slice(offset, endOffset),
      });
      // Measure the actual prompt, including repeated context, range metadata and JSON escaping.
      let endOffset = Math.min(record.content.length, offset + 80_000);
      if (!fits([...chunk, slice(endOffset)])) {
        let low = offset;
        let high = endOffset - 1;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2);
          if (fits([...chunk, slice(middle)])) low = middle;
          else high = middle - 1;
        }
        endOffset = low;
      }
      if (endOffset === offset) {
        if (!chunk.length)
          throw new EvidenceReviewFailure(
            'Evidence review context leaves no evidence slice budget.',
          );
        chunks.push(chunk);
        chunk = [];
        continue;
      }
      chunk.push(slice(endOffset));
      offset = endOffset;
      if (offset < record.content.length) {
        chunks.push(chunk);
        chunk = [];
      }
    }
  }
  if (chunk.length) chunks.push(chunk);
  const ranges = (slices: Slice[]) => slices.map(({ content: _content, ...range }) => range);
  const synthesisInput = (reviewedEvidence: unknown) => ({
    ...context,
    reviewedEvidence,
    coverage: `${scope}All admitted serialized records were covered. Synthesize the source-linked reviews, reconcile differing observation times and conflicting claims; complete coverage does not prove the candidate.`,
  });
  // Reserve the maximum permitted review output before spending any provider calls.
  const reserved = chunks.map((slices) => ({ slices: ranges(slices), review: 'x'.repeat(4_000) }));
  if (JSON.stringify(synthesisInput(reserved)).length > 96_000)
    throw new EvidenceReviewFailure(
      'Evidence review context leaves insufficient synthesis budget.',
    );
  const reviewed: {
    slices: Omit<Slice, 'content'>[];
    review: Infer<typeof evidenceSliceSchema>;
  }[] = [];
  const covered = new Map<string, number>();
  for (const slices of chunks) {
    const review = await generate(chunkInput(slices), 96_000, 'slice', evidenceSliceSchema);
    const serializedLength = JSON.stringify(review).length;
    if (serializedLength > 4_000)
      throw new EvidenceReviewFailure(
        `Evidence review slice output budget exceeded (${serializedLength} > 4000); coverage is incomplete.`,
      );
    // The slice reviewer ran out of its own output bounds; that is a budget limit, not a finding.
    if (!review.complete)
      throw new EvidenceReviewFailure('Evidence review slice coverage is incomplete.', 'budget');
    // A note must rest on a record this chunk read; it may relate that record to another admitted one.
    const read = new Set(slices.map((slice) => slice.evidenceId));
    if (
      review.notes.some(
        (note) =>
          !note.evidenceIds.some((id) => read.has(id)) ||
          note.evidenceIds.some((id) => !allowed.has(id)),
      )
    )
      throw new EvidenceReviewFailure(
        'Evidence review slice cited foreign or unadmitted evidence.',
        'validation',
      );
    for (const slice of slices) {
      if ((covered.get(slice.evidenceId) ?? 0) !== slice.offset)
        throw new EvidenceReviewFailure('Evidence review coverage contains a gap or overlap.');
      covered.set(slice.evidenceId, slice.endOffset);
    }
    reviewed.push({ slices: ranges(slices), review });
  }
  if (records.some((record) => covered.get(record.id!) !== record.content.length))
    throw new EvidenceReviewFailure('Evidence review coverage is incomplete.');
  return finalReview(synthesisInput(reviewed), 96_000, 'synthesis');
}
