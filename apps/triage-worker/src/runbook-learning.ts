import type { LearningProvenance } from '@sre/agent-tools';
import type { LearningInput } from '@sre/db';
import { topicNamesPerson } from './blameless';

/** One durable environment fact a distil proposes, with what it cites. */
export interface DistilFact {
  topic: string;
  statement: string;
  basis: 'observed' | 'responder';
  evidenceIds?: string[];
  messageIds?: string[];
}

/**
 * Saves the facts a distil proposes under the same rules as record_learning: a topic naming a person
 * is refused, not rewritten, and an unproven fact is dropped, never saved under a weaker basis.
 *
 * @param input - Tenant, incident, proposed facts, member emails, the prompt the generator saw, and
 *   the cleaner, provenance gate and writer to use.
 */
export async function recordDistilFacts(input: {
  tenantId: string;
  incidentId: string;
  facts: readonly DistilFact[];
  emails: string[];
  material: string;
  clean: (text: string) => string;
  validate: (tenantId: string, incidentId: string, fact: DistilFact) => Promise<LearningProvenance>;
  learn: (tenantId: string, learning: LearningInput) => Promise<unknown>;
}): Promise<void> {
  const { tenantId, incidentId } = input;
  for (const fact of input.facts) {
    const provenance = topicNamesPerson(input.emails, fact.topic, input.material)
      ? { ok: false as const, reason: 'topic names a person' }
      : await input.validate(tenantId, incidentId, fact);
    if (!provenance.ok) {
      console.info(
        JSON.stringify({
          level: 'info',
          app: 'triage-worker',
          event: 'learning.distil_fact_dropped',
          tenantId,
          incidentId,
          basis: fact.basis,
          reason: provenance.reason,
        }),
      );
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
