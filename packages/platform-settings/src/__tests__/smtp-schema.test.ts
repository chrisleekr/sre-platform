import { describe, expect, test } from 'vitest';
import { loadDefaults } from '../schema';

describe('SMTP environment fallback', () => {
  test('rejects partial and malformed environment state instead of silently disabling email', () => {
    for (const env of [
      { SMTP_HOST: 'smtp.example.test' },
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: 'not-a-port',
        SMTP_SECURE: 'true',
        SMTP_FROM: 'alerts@example.test',
      },
      {
        SMTP_HOST: 'smtp.example.test',
        SMTP_PORT: '587',
        SMTP_SECURE: 'sometimes',
        SMTP_FROM: 'alerts@example.test',
      },
    ]) {
      expect(() => loadDefaults(env as NodeJS.ProcessEnv)).toThrow('invalid SMTP environment');
    }
  });

  test('keeps a completely absent SMTP environment disabled', () => {
    expect(loadDefaults({} as NodeJS.ProcessEnv).SMTP).toBeNull();
  });
});
