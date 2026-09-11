import { describe, expect, test } from 'vitest';
import { renderIncidentRelationContext, type IncidentRelationContext } from '../relation-context';

const currentId = '11111111-1111-4111-8111-111111111111';
const priorId = '22222222-2222-4222-8222-222222222222';

function relation(over: Partial<IncidentRelationContext> = {}): IncidentRelationContext {
  return {
    sourceIncidentId: currentId,
    targetIncidentId: priorId,
    type: 'recurrence_of',
    rationale: 'Alertmanager reported a new start time for the same provider fingerprint.',
    evidence: ['provider_fingerprint:abc', 'previous_starts_at:2026-08-25T00:00:00Z'],
    sourceIncident: {
      id: currentId,
      title: 'New checkout firing',
      service: 'checkout',
      severity: 'sev2',
      status: 'open',
      investigationStatus: 'gathering',
      rcaSummary: null,
      confidence: null,
    },
    targetIncident: {
      id: priorId,
      title: 'Previous checkout firing',
      service: 'checkout',
      severity: 'sev2',
      status: 'resolved',
      investigationStatus: 'assessed',
      rcaSummary: 'A rollout exhausted the database connection pool.',
      confidence: 88,
    },
    ...over,
  };
}

describe('renderIncidentRelationContext', () => {
  test('gives the investigator prior evidence and assessment without treating recurrence as proof', () => {
    const rendered = renderIncidentRelationContext(currentId, [relation()]);

    expect(rendered).toContain('similarity is not proof');
    expect(rendered).toContain('relation=recurrence_of');
    expect(rendered).toContain(`incident=${priorId}`);
    expect(rendered).toContain(
      'prior_assessment=A rollout exhausted the database connection pool.',
    );
    expect(rendered).toContain('prior_confidence=88');
  });

  test('bounds relationship context before it reaches the model', () => {
    const rendered = renderIncidentRelationContext(
      currentId,
      Array.from({ length: 30 }, (_, index) =>
        relation({
          rationale: `${index}:${'r'.repeat(2_000)}`,
          evidence: ['e'.repeat(2_000)],
        }),
      ),
    );

    expect(rendered.length).toBeLessThanOrEqual(8_000);
  });
});
