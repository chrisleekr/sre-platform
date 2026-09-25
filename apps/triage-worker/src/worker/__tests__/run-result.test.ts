import { expect, test } from 'vitest';
import type { TriageResult } from '../../engine/types';
import { incidentFindingPayload, investigationRunResult } from '../run-result';

const secret = 'AKIAIOSFODNN7EXAMPLE';
const rejected: TriageResult = {
  provider: 'fake',
  sessionId: 'fake',
  outcome: 'inconclusive',
  turnBudget: 1,
  summary: 'Grafana was OOMKilled at 09:12Z.',
  confidence: 0,
  nextStep: 'Query container RSS against the limit.',
  reviewGaps: ['Confirm the termination reason per restart.', `Check key ${secret}`],
};

test('an unverified finding carries the reviewer gaps through the public sanitizer', () => {
  const finding = incidentFindingPayload(
    rejected,
    'run-1',
    'not_promoted',
    'investigation_inconclusive',
  );
  expect(finding.nextStep).toBe('Query container RSS against the limit.');
  expect(finding.gaps).toHaveLength(2);
  expect(finding.gaps![0]).toBe('Confirm the termination reason per restart.');
  expect(finding.gaps!.join(' ')).not.toContain(secret);
  expect(investigationRunResult(rejected).gaps).toEqual(finding.gaps);
});

test('a result without reviewer gaps records no gaps key', () => {
  const plain = { ...rejected, reviewGaps: [] };
  expect(
    incidentFindingPayload(plain, 'run-1', 'not_promoted', 'investigation_inconclusive'),
  ).not.toHaveProperty('gaps');
  expect(investigationRunResult(plain)).not.toHaveProperty('gaps');
});
