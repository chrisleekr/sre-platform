import { describe, expect, test, vi } from 'vitest';
import {
  selectSingleCorrelationVerdict,
  replaySemanticDisposition,
  semanticCorrelationVerdict,
  shadowSafeCorrelationVerdict,
} from '../semantic-routing';

describe('single-decision semantic routing', () => {
  test('never invokes the legacy classifier after a semantic result', async () => {
    const classifyLegacy = vi.fn(async () => ({ decision: 'not_worthy' as const }));
    await expect(
      selectSingleCorrelationVerdict(
        {
          disposition: 'investigate',
          decision: 'new_incident',
          reason: 'Active customer-visible failure.',
          service: 'checkout',
          severity: 'sev1',
          title: 'Checkout unavailable',
        },
        { service: 'fallback', severity: 'sev3', title: 'Fallback' },
        classifyLegacy,
      ),
    ).resolves.toEqual({
      decision: 'new_incident',
      service: 'checkout',
      severity: 'sev1',
      title: 'Checkout unavailable',
    });
    expect(classifyLegacy).not.toHaveBeenCalled();
  });

  test('preserves an authorized recovery selection even though its disposition is log', () => {
    expect(
      semanticCorrelationVerdict(
        {
          disposition: 'log',
          decision: 'resolves_signal',
          signalIndex: 2,
          reason: 'The provider reports a matching recovery.',
        },
        { service: 'fallback', severity: 'sev3', title: 'Fallback' },
      ),
    ).toEqual({ decision: 'resolves_signal', signalIndex: 2 });
  });

  test('keeps disposition orthogonal to an existing-incident selection', () => {
    expect(
      semanticCorrelationVerdict(
        {
          disposition: 'ticket',
          decision: 'belongs_to',
          index: 1,
          reason: 'Related risk belongs with the active incident but needs no new investigation.',
          action: 'Review after recovery.',
          safeDeferralReason: 'The active incident already owns diagnosis.',
          riskIfIgnored: 'The follow-up may be lost.',
          reviewHorizonMinutes: 60,
        },
        { service: 'fallback', severity: 'sev3', title: 'Fallback' },
      ),
    ).toEqual({ decision: 'belongs_to', index: 1 });
  });

  test('never lets a shadow ticket or log suppress conservative routing', () => {
    expect(
      shadowSafeCorrelationVerdict(
        {
          disposition: 'log',
          decision: 'standalone',
          reason: 'Model proposes no action.',
        },
        { decision: 'not_worthy' },
        { service: 'slack:C1', severity: 'sev3', title: 'Unclassified signal' },
      ),
    ).toEqual({
      decision: 'new_incident',
      service: 'slack:C1',
      severity: 'sev3',
      title: 'Unclassified signal',
    });
  });
});

describe('durable semantic replay', () => {
  const row = {
    disposition: 'log',
    reason: 'Matching provider recovery.',
    service: 'checkout',
    severity: 'sev3',
    proposedTitle: 'Checkout recovered',
    correlationDecision: 'resolves_signal',
    correlatedIncidentId: null,
    correlatedSignalId: 'signal-2',
    action: null,
    safeDeferralReason: null,
    riskIfIgnored: null,
    reviewHorizonMinutes: null,
  } as never;

  test('resolves persisted opaque IDs against the current bounded candidate ordering', () => {
    expect(
      replaySemanticDisposition(row, [], [{ id: 'signal-1' }, { id: 'signal-2' }] as never),
    ).toMatchObject({
      disposition: 'log',
      decision: 'resolves_signal',
      signalIndex: 2,
    });
  });

  test('rejects replay when its authorized target is no longer available', () => {
    expect(() => replaySemanticDisposition(row, [], [])).toThrow(
      'persisted recovery target is unavailable',
    );
  });
});
