import { describe, expect, test } from 'vitest';
import { COALESCING_TYPES } from '../queue/contracts';

// a double-click on Generate postmortem, or a second grade request for the same run,
// must be absorbed like runbook.generate rather than surface a 23505 to the caller. Both types
// are absent from the set at HEAD, so this is RED until the queue contract grows them.
describe('generation job coalescing', () => {
  test('postmortem.generate is a coalescing job type', () => {
    expect(COALESCING_TYPES.has('postmortem.generate')).toBe(true);
  });

  test('assessment.grade is a coalescing job type', () => {
    expect(COALESCING_TYPES.has('assessment.grade')).toBe(true);
  });

  test('runbook.generate keeps coalescing', () => {
    expect(COALESCING_TYPES.has('runbook.generate')).toBe(true);
  });
});
