import { describe, expect, test } from 'vitest';
import { emailToLabel, resolveAuthorLabel } from '../author-label';

// The two security-relevant rules live here: local-part ONLY (AC5, no PII address to Slack) and
// never-throws (AC4, a lookup failure degrades to unattributed). Pure, no DB.
describe('emailToLabel', () => {
  test('reduces a full address to its local-part only', () => {
    expect(emailToLabel('jane.doe@corp.io')).toBe('jane.doe');
  });

  test('null/undefined → null (unresolved)', () => {
    expect(emailToLabel(null)).toBeNull();
    expect(emailToLabel(undefined)).toBeNull();
  });

  test("a string with no '@' is not a usable address → null", () => {
    expect(emailToLabel('nope')).toBeNull();
  });

  test('an empty local-part → null', () => {
    expect(emailToLabel('@corp.io')).toBeNull();
  });
});

describe('resolveAuthorLabel', () => {
  test('never throws — a lookup that throws resolves to null (AC4)', async () => {
    const throwing = async (): Promise<string | null> => {
      throw new Error('db down');
    };
    await expect(resolveAuthorLabel(throwing, 't1', 'u1')).resolves.toBeNull();
  });

  test('reduces the looked-up email to its local-part', async () => {
    const lookup = async (): Promise<string | null> => 'a@b.io';
    expect(await resolveAuthorLabel(lookup, 't1', 'u1')).toBe('a');
  });

  test('a null lookup resolves to null (unattributed)', async () => {
    const lookup = async (): Promise<string | null> => null;
    expect(await resolveAuthorLabel(lookup, 't1', 'u1')).toBeNull();
  });
});
