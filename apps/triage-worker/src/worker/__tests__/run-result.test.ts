import type { FindingLink } from '@sre/contracts';
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

test('an unverified finding carries the reviewer gaps verbatim', () => {
  const finding = incidentFindingPayload(
    rejected,
    'run-1',
    'not_promoted',
    'investigation_inconclusive',
  );
  expect(finding.nextStep).toBe('Query container RSS against the limit.');
  expect(finding.gaps).toHaveLength(2);
  expect(finding.gaps![0]).toBe('Confirm the termination reason per restart.');
  expect(finding.gaps![1]).toBe(`Check key ${secret}`);
  expect(investigationRunResult(rejected).gaps).toEqual(finding.gaps);
});

test('review provenance persists with the candidate verdict and the detail verbatim', () => {
  const review = {
    status: 'rejected' as const,
    rejection: 'insufficient_evidence' as const,
    coverage: 'full' as const,
    candidate: { outcome: 'conclusive' as const, confidence: 85 },
    detail: `Restart reason unproven. key ${secret}`,
  };
  const persisted = investigationRunResult({ ...rejected, review });
  expect(persisted.confidence).toBe(0);
  expect(persisted.review).toEqual(review);
  expect(investigationRunResult(rejected)).not.toHaveProperty('review');
});

test('a result without reviewer gaps records no gaps key', () => {
  const plain = { ...rejected, reviewGaps: [] };
  expect(
    incidentFindingPayload(plain, 'run-1', 'not_promoted', 'investigation_inconclusive'),
  ).not.toHaveProperty('gaps');
  expect(investigationRunResult(plain)).not.toHaveProperty('gaps');
});

test('the likely cause is the first hypothesis still standing, and links pass through', () => {
  const links: FindingLink[] = [
    { kind: 'commit', label: '3391576a', url: 'https://gitlab.example.com/g/a/-/commit/3391576a' },
  ];
  const finding = incidentFindingPayload(
    {
      ...rejected,
      links,
      rankedHypotheses: [
        { hypothesis: 'Disproven idea.', confidence: 5, evidence: 'e', state: 'disproven' },
        { hypothesis: `Limit too low, key ${secret}.`, confidence: 60, evidence: 'e' },
      ],
    },
    'run-1',
    'not_promoted',
    'investigation_inconclusive',
  );
  expect(finding.likelyCause).toMatch(/^Limit too low/);
  expect(finding.likelyCause).toContain(secret);
  expect(finding.links).toEqual(links);
  expect(
    incidentFindingPayload(rejected, 'run-1', 'not_promoted', 'investigation_inconclusive'),
  ).not.toHaveProperty('likelyCause');
});

test('a leading hypothesis headlines the finding even when the model ranked another first', () => {
  const finding = incidentFindingPayload(
    {
      ...rejected,
      rankedHypotheses: [
        { hypothesis: 'Plausible idea.', confidence: 40, evidence: 'e', state: 'plausible' },
        { hypothesis: 'Leading idea.', confidence: 70, evidence: 'e', state: 'leading' },
      ],
    },
    'run-1',
    'trusted_assessment',
    'conclusive_assessment',
  );
  expect(finding.likelyCause).toBe('Leading idea.');
});

test('a trusted finding names a cause only when a hypothesis is leading', () => {
  const finding = incidentFindingPayload(
    {
      ...rejected,
      rankedHypotheses: [
        { hypothesis: 'Plausible idea.', confidence: 40, evidence: 'e', state: 'plausible' },
      ],
    },
    'run-1',
    'trusted_assessment',
    'conclusive_assessment',
  );
  expect(finding).not.toHaveProperty('likelyCause');
});
