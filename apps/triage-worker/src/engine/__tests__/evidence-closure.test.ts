import { describe, expect, test } from 'vitest';
import { evidenceClosureDecision } from '../evidence-closure';

const observable = (attemptedEvidenceIds: string[] = []) => ({
  question: 'Which configuration is active?',
  category: 'observable' as const,
  evidenceKind: 'runtime_configuration' as const,
  attemptedEvidenceIds,
});

describe('evidenceClosureDecision', () => {
  test('challenges an unattempted observable question once', () => {
    const decision = evidenceClosureDecision([observable()], [], {
      challengeUsed: false,
      canContinue: true,
    });
    expect(decision.challenge).toBe(true);
    expect(decision.message).toContain('runtime_configuration');
  });

  test('accepts a durable cited attempt regardless of its outcome', () => {
    const evidenceId = '11111111-1111-4111-8111-111111111111';
    expect(
      evidenceClosureDecision(
        [observable([evidenceId])],
        [{ evidenceId, tool: 'read_configuration', outcome: 'unavailable' }],
        { challengeUsed: false, canContinue: true },
      ),
    ).toEqual({ challenge: false, message: null });
  });

  test('challenges partial evidence that cites no durable attempt', () => {
    expect(
      evidenceClosureDecision([{ ...observable(), category: 'partial_evidence' }], [], {
        challengeUsed: false,
        canContinue: true,
      }).challenge,
    ).toBe(true);
  });

  test('never challenges human decisions or an exhausted closure budget', () => {
    const operatorDecision = {
      ...observable(),
      category: 'operator_decision' as const,
      evidenceKind: null,
    };
    expect(
      evidenceClosureDecision([operatorDecision], [], {
        challengeUsed: false,
        canContinue: true,
      }).challenge,
    ).toBe(false);
    expect(
      evidenceClosureDecision([observable()], [], {
        challengeUsed: true,
        canContinue: true,
      }).challenge,
    ).toBe(false);
  });
});
