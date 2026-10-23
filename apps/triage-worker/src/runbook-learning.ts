import * as z from 'zod';
import { MAX_LEARNINGS_PER_RUN, type LearningProvenance } from '@sre/agent-tools';
import type { LearningInput } from '@sre/db';
import { topicNamesPerson } from './blameless';

// Durable environment facts are saved as separate per-topic records so each is embedded on its
// own and never cut off by the embedder's input limit inside a long runbook.
// Same bounds as record_learning, so neither path can store what the other would refuse. Cited ids
// are plain strings, and a fact or list outside the bounds parses as dropped, so one bad fact never
// fails the distil and loses the runbook beside it. Not every provider enforces the bounds in decoding.
const EnvironmentFactSchema = z.object({
  topic: z.string().trim().min(3).max(120),
  statement: z.string().trim().min(10).max(500),
  basis: z.enum(['observed', 'responder']),
  evidenceIds: z.array(z.string()).max(20).optional(),
  messageIds: z.array(z.string()).max(5).optional(),
});
export const EnvironmentFactsSchema = z
  .array(EnvironmentFactSchema.nullable().catch(null))
  .max(MAX_LEARNINGS_PER_RUN)
  .optional()
  .catch(undefined);

/** One durable environment fact a distil proposes, with what it cites. */
export type DistilFact = z.infer<typeof EnvironmentFactSchema>;

/**
 * Saves the facts a distil proposes under the same rules as record_learning: a topic naming a person
 * is refused, not rewritten, and an unproven fact is dropped, never saved under a weaker basis. A null
 * is a fact the schema dropped for breaking its bounds.
 *
 * @param input - Tenant, incident, proposed facts, member emails, the prompt the generator saw, and
 *   the cleaner, provenance gate and writer to use.
 */
export async function recordDistilFacts(input: {
  tenantId: string;
  incidentId: string;
  facts: readonly (DistilFact | null)[];
  emails: string[];
  material: string;
  clean: (text: string) => string;
  validate: (tenantId: string, incidentId: string, fact: DistilFact) => Promise<LearningProvenance>;
  learn: (tenantId: string, learning: LearningInput) => Promise<unknown>;
}): Promise<void> {
  const { tenantId, incidentId } = input;
  const drop = (reason: string, basis?: string) =>
    console.info(
      JSON.stringify({
        level: 'info',
        app: 'triage-worker',
        event: 'learning.distil_fact_dropped',
        tenantId,
        incidentId,
        basis,
        reason,
      }),
    );
  for (const fact of input.facts) {
    if (!fact) {
      drop('fact breaks the schema bounds');
      continue;
    }
    const provenance = topicNamesPerson(input.emails, fact.topic, input.material)
      ? { ok: false as const, reason: 'topic names a person' }
      : await input.validate(tenantId, incidentId, fact);
    if (!provenance.ok) {
      drop(provenance.reason, fact.basis);
      continue;
    }
    await input.learn(tenantId, {
      topic: fact.topic,
      statement: input.clean(fact.statement),
      basis: fact.basis,
      ...(provenance.source ? { source: provenance.source } : {}),
      sourceIncidentId: incidentId,
    });
  }
}
