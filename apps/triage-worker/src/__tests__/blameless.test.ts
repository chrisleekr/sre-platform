import { describe, expect, test } from 'vitest';
import {
  BLAMELESS_SYSTEM_PROMPT,
  collectHumanIdentifiers,
  stripHumanIdentifiers,
} from '../blameless';

// Blameless by construction (SRE Ch 15): the prompt forbids naming a person, and this guard
// removes the identifiers the platform can know (member emails, their local parts, mention tokens)
// from whatever the model produced anyway.
describe('blameless guard', () => {
  const material = [
    'alice@example.com restarted the pods.',
    '<@U123> approved the rollback and @bob paged the DBA.',
  ].join('\n');

  test('collects member emails, their local parts and every mention token, longest first', () => {
    const ids = collectHumanIdentifiers(['Alice@Example.com', 'cy@example.com'], material);
    // Exact set, order asserted only as non-increasing length so ties do not encode Set insertion
    // order. "cy" is too short to strip safely; the email itself is still an identifier. A mention
    // also yields its bare handle (the HANDLE lookbehind admits `<`).
    expect(ids).toHaveLength(6);
    expect(new Set(ids)).toEqual(
      new Set(['alice@example.com', 'cy@example.com', '<@U123>', 'alice', '@u123', '@bob']),
    );
    const lengths = ids.map((id) => id.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
  });

  test('a labelled Slack mention is stripped whole, leaving no label residue', () => {
    expect(stripHumanIdentifiers('<@U123|alice> approved it.', [])).toBe(
      'a responder approved it.',
    );
    expect(collectHumanIdentifiers([], '<@U123|alice> approved it.')).toContain('<@U123|alice>');
  });

  test('a labelled mention absent from the material is still stripped whole', () => {
    // The identifier loop knows `@u123` from the bare mention; run before the mention pass it would
    // strip the id and leave `<a responder|alice>`.
    const ids = collectHumanIdentifiers([], '<@U123> approved it.');
    expect(stripHumanIdentifiers('<@U123|alice> approved it.', ids)).toBe(
      'a responder approved it.',
    );
  });

  test('a mention label is a human identifier and is stripped when it appears bare', () => {
    const ids = collectHumanIdentifiers([], '<@U123|alice> approved it.');
    expect(ids).toContain('alice');
    expect(stripHumanIdentifiers('alice restarted the pods', ids)).toBe(
      'a responder restarted the pods',
    );
  });

  test('a mention label cannot swallow text up to an unrelated close bracket', () => {
    const out = stripHumanIdentifiers('<@U123|broken then <b>bold</b> and done.', []);
    expect(out).toContain('bold');
    expect(out).toContain('done.');
  });

  test('strips emails, local parts, Slack mentions and handles from generated prose', () => {
    const ids = collectHumanIdentifiers(['alice@example.com'], material);
    const out = stripHumanIdentifiers(
      'Alice (alice@example.com) misconfigured the pool; <@U123> and @bob missed the alert.',
      ids,
    );
    expect(out).not.toMatch(/alice|U123|@bob/iu);
    expect(out).toBe(
      'a responder (a responder) misconfigured the pool; a responder and a responder missed the alert.',
    );
  });

  test('strips an email that belongs to no member', () => {
    expect(
      stripHumanIdentifiers('bob@vendor.com and ops+oncall@corp.example.org escalated.', []),
    ).toBe('a responder and a responder escalated.');
  });

  test('is bounded: a local part inside another word survives', () => {
    const ids = collectHumanIdentifiers(['alice@example.com'], '');
    expect(stripHumanIdentifiers('Malice was not a factor; alice was.', ids)).toBe(
      'Malice was not a factor; a responder was.',
    );
    expect(stripHumanIdentifiers('Nothing to strip.', [])).toBe('Nothing to strip.');
  });

  test('the system prompt forbids naming individuals and types the action items', () => {
    expect(BLAMELESS_SYSTEM_PROMPT).toMatch(/never name/iu);
    for (const type of ['prevent', 'mitigate', 'process']) {
      expect(BLAMELESS_SYSTEM_PROMPT).toContain(type);
    }
  });
});
