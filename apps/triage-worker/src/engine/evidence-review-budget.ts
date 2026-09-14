import { scrubSecrets } from '@sre/agent-tools';
import type { ZodType } from 'zod';
import type {
  InvestigationEvidence,
  StructuredGenerator,
  TriageInput,
  TriageResult,
} from './types';

interface Review {
  supported: boolean;
  summary: string;
  detail?: string;
  reason: string;
  evidenceIds: string[];
}

interface Slice {
  evidenceId: string;
  offset: number;
  endOffset: number;
  totalLength: number;
  content: string;
}

/** Safe classifications contain no provider payload or unreviewed instructions. */
export class EvidenceReviewFailure extends Error {}

/** Cover each serialized record exactly once before allowing synthesis.
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
): Promise<Review> {
  const context = { task: task ? { ...task, evidence: undefined } : undefined, candidate };
  const allowed = new Set(evidence.flatMap((record) => (record.id ? [record.id] : [])));
  const generate = async (
    value: unknown,
    cap: number,
    chunk = false,
    permitted = allowed,
  ): Promise<Review> => {
    signal.throwIfAborted();
    const prompt = scrubSecrets(JSON.stringify(value));
    if (prompt.length > cap)
      throw new EvidenceReviewFailure(
        'Evidence review input budget exceeded; coverage is incomplete.',
      );
    const review = schema.parse(
      await generator.generate(prompt, schema, {
        signal,
        system:
          instruction +
          (chunk
            ? '\nReview only this evidence slice. Return concise source-linked observations and corrections in at most 4,000 serialized characters. A slice is not the full record. Preserve observation times, units and contradictory facts for synthesis; do not infer absence outside the slice.'
            : ''),
      }),
    );
    signal.throwIfAborted();
    if (review.evidenceIds.some((id) => !permitted.has(id)))
      throw new EvidenceReviewFailure('Evidence review cited foreign or unadmitted evidence.');
    if (chunk && JSON.stringify(review).length > 4_000)
      throw new EvidenceReviewFailure(
        'Evidence review chunk output budget exceeded; coverage is incomplete.',
      );
    return review;
  };
  const single = {
    ...context,
    evidence,
    coverage: 'Bounded records, not proof of historical absence',
  };
  if (scrubSecrets(JSON.stringify(single)).length <= 160_000) return generate(single, 160_000);

  const records = evidence.map((record) => ({
    id: record.id,
    content: scrubSecrets(JSON.stringify(record)),
  }));
  if (
    records.some((record) => !record.id) ||
    records.reduce((total, record) => total + record.content.length, 0) > 480_000
  )
    throw new EvidenceReviewFailure(
      'Evidence review input budget exceeded; coverage is incomplete.',
    );
  const chunks: Slice[][] = [];
  let chunk: Slice[] = [];
  let remaining = 80_000;
  for (const record of records) {
    for (let offset = 0; offset < record.content.length;) {
      const endOffset = Math.min(record.content.length, offset + remaining);
      chunk.push({
        evidenceId: record.id!,
        offset,
        endOffset,
        totalLength: record.content.length,
        content: record.content.slice(offset, endOffset),
      });
      remaining -= endOffset - offset;
      offset = endOffset;
      if (remaining === 0) {
        chunks.push(chunk);
        chunk = [];
        remaining = 80_000;
      }
    }
  }
  if (chunk.length) chunks.push(chunk);
  const reviewed: { slices: Omit<Slice, 'content'>[]; review: Review }[] = [];
  const covered = new Map<string, number>();
  for (const slices of chunks) {
    const review = await generate(
      {
        ...context,
        evidenceSlices: slices,
        coverage:
          'Partial record slices; offsets are half-open serialized-record character ranges.',
      },
      96_000,
      true,
      new Set(slices.map((slice) => slice.evidenceId)),
    );
    for (const slice of slices) {
      if ((covered.get(slice.evidenceId) ?? 0) !== slice.offset)
        throw new EvidenceReviewFailure('Evidence review coverage contains a gap or overlap.');
      covered.set(slice.evidenceId, slice.endOffset);
    }
    reviewed.push({ slices: slices.map(({ content: _content, ...range }) => range), review });
  }
  if (records.some((record) => covered.get(record.id!) !== record.content.length))
    throw new EvidenceReviewFailure('Evidence review coverage is incomplete.');
  return generate(
    {
      ...context,
      reviewedEvidence: reviewed,
      coverage:
        'All admitted serialized records were covered. Synthesize the source-linked reviews, reconcile differing observation times and conflicting claims; complete coverage does not prove the candidate.',
    },
    96_000,
  );
}
