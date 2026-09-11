// Pure SLO math and its text rendering. No I/O, so this is the falsifier for every number the read
// model shows: the budget fraction, the burn multiple, the linear exhaustion projection, and the one
// headline every surface shares. RED until `packages/slo` exists.
import { describe, expect, test } from 'vitest';
import {
  errorBudget,
  budgetRemaining,
  burnRate,
  projectExhaustionDays,
  sloHeadline,
  renderSloStatus,
  type SloStatus,
} from '../compute';

describe('errorBudget', () => {
  test('is 1 - target', () => {
    expect(errorBudget(0.999)).toBeCloseTo(0.001, 12);
    expect(errorBudget(0.99)).toBeCloseTo(0.01, 12);
  });
});

describe('budgetRemaining', () => {
  test('half the allowance spent leaves 0.5 remaining', () => {
    expect(budgetRemaining(0.0005, 0.999)).toBeCloseTo(0.5, 9);
  });

  test('exactly at budget leaves 0 remaining', () => {
    expect(budgetRemaining(0.001, 0.999)).toBeCloseTo(0, 9);
  });

  test('over budget stays signed and negative, so a caller can report the overage', () => {
    expect(budgetRemaining(0.002, 0.999)).toBeCloseTo(-1, 9);
  });

  test('no bad events leaves the full budget', () => {
    expect(budgetRemaining(0, 0.999)).toBe(1);
  });
});

describe('burnRate', () => {
  test('a bad ratio equal to the budget burns at 1x', () => {
    expect(burnRate(0.001, 0.999)).toBeCloseTo(1, 9);
  });

  test('the 30-day budget gone in ~50h is the 14.4x fast-burn multiple', () => {
    expect(burnRate(0.0144, 0.999)).toBeCloseTo(14.4, 6);
  });

  test('no bad events is a 0x burn', () => {
    expect(burnRate(0, 0.999)).toBe(0);
  });
});

describe('projectExhaustionDays', () => {
  test('at 1x burn, half a 30d budget lasts 15 days', () => {
    expect(projectExhaustionDays(0.5, 1, 30)).toBeCloseTo(15, 9);
  });

  test('at 14.4x burn, half a 30d budget lasts about a day', () => {
    expect(projectExhaustionDays(0.5, 14.4, 30)).toBeCloseTo(1.0416666, 5);
  });

  test('not burning projects nothing rather than infinity', () => {
    expect(projectExhaustionDays(0.5, 0, 30)).toBe(null);
    expect(projectExhaustionDays(0.5, -1, 30)).toBe(null);
  });

  test('an already-spent budget projects 0, not a negative time', () => {
    expect(projectExhaustionDays(0, 2, 30)).toBe(0);
    expect(projectExhaustionDays(-0.4, 2, 30)).toBe(0);
  });
});

const headlineInput = {
  name: 'checkout',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
};

describe('sloHeadline', () => {
  test('names the objective, its service, its type, its target and its window', () => {
    expect(sloHeadline(headlineInput)).toBe(
      'SLO "checkout" (checkout, availability 99.9% over 30d)',
    );
  });
});

const status = (over: Partial<SloStatus> = {}): SloStatus => ({
  ...headlineInput,
  budgetRemaining: 0.5,
  burnRate: 2,
  burnWindow: '1h',
  exhaustionDays: 7.5,
  ...over,
});

describe('renderSloStatus', () => {
  test('renders budget, burn and projection on one line', () => {
    expect(renderSloStatus(status())).toBe(
      'SLO "checkout" (checkout, availability 99.9% over 30d): 50.0% budget remaining; burn 2.0x over 1h; budget exhausts in ~7.5 days.',
    );
  });

  test('an over-budget SLO reports the overage rather than a negative percentage', () => {
    expect(renderSloStatus(status({ budgetRemaining: -0.25, exhaustionDays: 0 }))).toBe(
      'SLO "checkout" (checkout, availability 99.9% over 30d): budget EXHAUSTED (over by 25.0%); burn 2.0x over 1h; budget already exhausted.',
    );
  });

  test('a non-burning SLO says so instead of projecting a date', () => {
    expect(renderSloStatus(status({ burnRate: 0, exhaustionDays: null }))).toBe(
      'SLO "checkout" (checkout, availability 99.9% over 30d): 50.0% budget remaining; burn 0.0x over 1h; not burning.',
    );
  });

  test('never suggests the platform will act on the budget: advisory text only', () => {
    const line = renderSloStatus(status({ budgetRemaining: -1 }));
    expect(line).not.toMatch(/incident|page|paging|rollback|block(ed|ing)?\b|freeze/i);
  });
});
