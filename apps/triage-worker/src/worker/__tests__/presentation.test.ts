import { expect, test } from 'vitest';
import type { RunbookSeed } from '../../runbook-seeder';
import { renderRunbookSeeds, summarizeRunbookSeeds } from '../presentation';

const seed = (
  category: string,
  occurrenceCount: number,
  match: RunbookSeed['match'] = 'similar',
): RunbookSeed => ({
  title: null,
  content: '',
  category,
  occurrenceCount,
  verified: false,
  match,
});

test('summarizes seeds without exposing their content', () => {
  expect(summarizeRunbookSeeds([])).toBe('');
  expect(summarizeRunbookSeeds([seed('fact', 1)])).toBe(
    'Using 1 recorded fact from past incidents.',
  );
  expect(summarizeRunbookSeeds([seed('runbook', 3), seed('investigation', 2)])).toBe(
    'Using 2 runbooks or notes from past incidents.',
  );
  expect(
    summarizeRunbookSeeds([seed('runbook', 10, 'monitor'), seed('runbook', 40), seed('fact', 1)]),
  ).toBe(
    'Using 2 runbooks or notes (most seen 10× on this monitor) and 1 recorded fact from past incidents.',
  );
  expect(summarizeRunbookSeeds([seed('runbook', 10, 'monitor')])).toBe(
    'Using 1 runbook or note (most seen 10× on this monitor) from past incidents.',
  );
});

test('labels each seed as a same-monitor or similar-incident match', () => {
  const rendered = renderRunbookSeeds([seed('runbook', 3, 'monitor'), seed('fact', 2, 'similar')]);
  expect(rendered).toContain('seen 3×, same monitor, unverified');
  expect(rendered).toContain('seen 2×, similar incident, unverified');
});
