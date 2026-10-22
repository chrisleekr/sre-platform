import { describe, expect, it } from 'vitest';
import { hasHighEntropyToken, hasKnownCredential, isSensitiveKey } from '../credential-detect';

describe('hasKnownCredential', () => {
  it.each([
    'Authorization:\r\n  hunter2',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE',
    'AKIAABCDEFGHIJKLMNOP',
    'Bearer abc.def',
    'sk-abcdefghijklmnopqrstuvwx',
    'ghp_abcdefghijklmnopqrstuvwx',
    'github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789',
    'xoxb-1234567890-abc',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln',
  ])('detects %j', (value) => {
    expect(hasKnownCredential(value)).toBe(true);
  });

  it('detects a sensitive key=value pair', () => {
    expect(hasKnownCredential('token=abc123')).toBe(true);
  });

  it('detects a vendor-prefixed token', () => {
    expect(hasKnownCredential('glpat-abcdefghijklmnopqrst')).toBe(true);
  });

  it('detects connection-URL userinfo', () => {
    // The userinfo pattern needs a scheme; bare `user:pw@host` is not a connection URL.
    expect(hasKnownCredential('https://user:pw@host/x')).toBe(true);
    expect(hasKnownCredential('postgres://user:pw@host/db')).toBe(true);
  });

  it('is stable across repeated calls on global regexes', () => {
    const token = 'glpat-abcdefghijklmnopqrst';
    expect(hasKnownCredential(token)).toBe(true);
    expect(hasKnownCredential(token)).toBe(true);
    expect(hasKnownCredential('plain text')).toBe(false);
  });

  it('accepts a long opaque id: the high-entropy heuristic is excluded', () => {
    expect(hasKnownCredential('1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms')).toBe(false);
  });

  it('accepts a benign key=value pair', () => {
    expect(hasKnownCredential('selectedIssue=OPS-1')).toBe(false);
  });
});

describe('hasHighEntropyToken', () => {
  it('flags a long mixed-case alphanumeric run and ignores uniform ones', () => {
    expect(hasHighEntropyToken('cause:aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV')).toBe(true);
    expect(hasHighEntropyToken('0123456789abcdef0123456789abcdef')).toBe(false);
    expect(hasHighEntropyToken('cause:deployment')).toBe(false);
    // `_` is a word character, so a run after it has no \b boundary.
    expect(hasHighEntropyToken('cause:prod_aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV')).toBe(true);
  });
});

describe('isSensitiveKey', () => {
  it('matches sensitive segments in any casing or separator style', () => {
    expect(isSensitiveKey('private_token')).toBe(true);
    expect(isSensitiveKey('Private_Token')).toBe(true);
    expect(isSensitiveKey('access-token')).toBe(true);
    expect(isSensitiveKey('apiKey')).toBe(true);
  });

  it('leaves benign keys alone', () => {
    expect(isSensitiveKey('selectedIssue')).toBe(false);
    expect(isSensitiveKey('https')).toBe(false);
  });
});
