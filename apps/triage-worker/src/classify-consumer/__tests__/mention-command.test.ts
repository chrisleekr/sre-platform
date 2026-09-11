import { describe, expect, test } from 'vitest';
import { isSignalPromotionCommand } from '../mention';

describe('signal promotion command', () => {
  test.each([
    'investigate',
    'Investigate this.',
    'promote',
    'promote ticket',
    '<@U012ABC> investigate',
  ])('%s is explicit', (text) => {
    expect(isSignalPromotionCommand(text)).toBe(true);
  });

  test.each([
    "don't investigate",
    'should we investigate?',
    'the old ticket was promoted',
    'investigate after business hours',
  ])('%s cannot promote a ticket', (text) => {
    expect(isSignalPromotionCommand(text)).toBe(false);
  });
});
