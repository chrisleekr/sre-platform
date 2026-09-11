import { describe, expect, test } from 'vitest';
import { loadDefaults, parseWrite } from '../schema';

const TOKEN_LIFETIME_KEY = 'MAX_TOKEN_LIFETIME_SEC';

describe('maximum token lifetime setting', () => {
  test('defaults to one day and accepts only the administrator-configurable safety range', () => {
    expect(loadDefaults({}).MAX_TOKEN_LIFETIME_SEC).toBe(86_400);
    expect(parseWrite(TOKEN_LIFETIME_KEY, 300).value).toBe(300);
    expect(parseWrite(TOKEN_LIFETIME_KEY, 2_592_000).value).toBe(2_592_000);
    expect(() => parseWrite(TOKEN_LIFETIME_KEY, 299)).toThrow(TypeError);
    expect(() => parseWrite(TOKEN_LIFETIME_KEY, 2_592_001)).toThrow(TypeError);
    expect(
      loadDefaults({ MAX_TOKEN_LIFETIME_SEC: '1800' } as NodeJS.ProcessEnv).MAX_TOKEN_LIFETIME_SEC,
    ).toBe(1_800);
  });
});
