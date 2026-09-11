import { describe, expect, test } from 'vitest';
import { loadDefaults, parseWrite } from '../schema';

describe('workspace registration mode', () => {
  test('defaults to approval and validates open, approval-required, and closed policies', () => {
    expect(loadDefaults({} as NodeJS.ProcessEnv).REGISTRATION_MODE).toBe('approval_required');
    expect(loadDefaults({ REGISTRATION_MODE: 'open' } as NodeJS.ProcessEnv).REGISTRATION_MODE).toBe(
      'open',
    );
    expect(
      loadDefaults({ REGISTRATION_MODE: 'invalid' } as NodeJS.ProcessEnv).REGISTRATION_MODE,
    ).toBe('approval_required');
    expect(
      loadDefaults({ REGISTRATION_MODE: 'closed' } as NodeJS.ProcessEnv).REGISTRATION_MODE,
    ).toBe('closed');
    expect(parseWrite('REGISTRATION_MODE', 'open')).toEqual({
      key: 'REGISTRATION_MODE',
      value: 'open',
    });
    expect(parseWrite('REGISTRATION_MODE', 'closed')).toEqual({
      key: 'REGISTRATION_MODE',
      value: 'closed',
    });
    expect(() => parseWrite('REGISTRATION_MODE', 'invalid')).toThrow(TypeError);
  });
});
