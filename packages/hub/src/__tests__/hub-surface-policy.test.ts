import { expect, test } from 'vitest';

import { shouldMirrorToSurfaces } from '../hub';

test('keeps automated progress in the hub and mirrors responder decisions', () => {
  expect(shouldMirrorToSurfaces({ author: 'agent', kind: 'tool_step' })).toBe(false);
  expect(shouldMirrorToSurfaces({ author: 'system', kind: 'text' })).toBe(false);
  expect(shouldMirrorToSurfaces({ author: 'human', kind: 'text' })).toBe(true);
  expect(shouldMirrorToSurfaces({ author: 'agent', kind: 'finding' })).toBe(true);
  expect(
    shouldMirrorToSurfaces({
      author: 'agent',
      kind: 'finding',
      finding: {
        runId: 'run-stale',
        outcome: 'failed',
        promotion: 'not_promoted',
        promotionReason: 'stale_evidence',
        evidenceIds: [],
        currentState: null,
        impact: null,
        nextStep: null,
      },
    }),
  ).toBe(false);
  expect(
    shouldMirrorToSurfaces({
      author: 'agent',
      kind: 'finding',
      finding: {
        runId: 'run-inconclusive',
        outcome: 'inconclusive',
        promotion: 'not_promoted',
        promotionReason: 'investigation_inconclusive',
        evidenceIds: [],
        currentState: null,
        impact: null,
        nextStep: null,
      },
    }),
  ).toBe(false);
  expect(
    shouldMirrorToSurfaces({
      author: 'agent',
      kind: 'finding',
      finding: {
        runId: 'run-decision',
        outcome: 'inconclusive',
        promotion: 'not_promoted',
        promotionReason: 'investigation_inconclusive',
        evidenceIds: [],
        currentState: null,
        impact: null,
        nextStep: 'Choose whether to fail over the service.',
      },
    }),
  ).toBe(true);
  expect(shouldMirrorToSurfaces({ author: 'agent', kind: 'approval' })).toBe(true);
});

test('reviewer gaps do not change whether an inconclusive finding is mirrored', () => {
  const finding = {
    runId: 'run-gaps',
    outcome: 'inconclusive' as const,
    promotion: 'not_promoted' as const,
    promotionReason: 'investigation_inconclusive' as const,
    evidenceIds: [],
    currentState: null,
    impact: null,
    gaps: ['Confirm the termination reason per restart.'],
  };
  expect(
    shouldMirrorToSurfaces({
      author: 'agent',
      kind: 'finding',
      finding: { ...finding, nextStep: null },
    }),
  ).toBe(false);
  expect(
    shouldMirrorToSurfaces({
      author: 'agent',
      kind: 'finding',
      finding: { ...finding, nextStep: 'Query container RSS against the limit.' },
    }),
  ).toBe(true);
});
