import { expect, test } from 'vitest';
import { incidentEvidencePreview } from '../incidentState';
import type { Incident } from '../types';

test('does not append uncited recent checks to one current citation', () => {
  const incident = { assessmentEvidenceIds: ['cited'] } as Incident;
  expect(incidentEvidencePreview(incident, false, ['recent-a', 'recent-b'])).toEqual({
    cited: true,
    ids: ['cited'],
  });
});

test('current recovery without citations falls back to recent checks despite historical assessment citations', () => {
  const incident = {
    assessmentEvidenceIds: ['historical'],
    recoveryEvidenceIds: [],
  } as unknown as Incident;
  expect(
    incidentEvidencePreview(incident, true, [
      'recent-a',
      'recent-b',
      'recent-a',
      'recent-c',
      'recent-d',
    ]),
  ).toEqual({ cited: false, ids: ['recent-a', 'recent-b', 'recent-c'] });
});
