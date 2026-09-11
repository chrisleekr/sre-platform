import { describe, expect, test } from 'vitest';
import { MESSAGES, messageForApiCode } from '../messages';

describe('onboarding message catalogue', () => {
  test('uses workspace language rather than backend implementation vocabulary', () => {
    const copy = Object.values(MESSAGES).join(' ');
    expect(copy).not.toMatch(/\b(?:tenant|founding|binding|provider|claim|issuer|membership)\b/i);
  });

  test('maps stable API codes without rendering raw server errors', () => {
    expect(messageForApiCode('workspace_address_taken')).toMatch(/workspace address/i);
    expect(messageForApiCode('public_email_domain')).toMatch(/work email domain/i);
    expect(messageForApiCode('registration_closed')).toMatch(/administrator/i);
    expect(messageForApiCode('unexpected_internal_detail')).toBe(MESSAGES.genericFailure);
  });
});
