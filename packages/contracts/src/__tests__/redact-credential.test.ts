import { describe, expect, it } from 'vitest';
import { hasKnownCredential, isSensitiveKey, scrubSecrets } from '../redact';

it.each([
  'password:\n  hunter2\nsafe source',
  '-----BEGIN PRIVATE KEY-----\nhunter2\n-----END PRIVATE KEY-----\nsafe source',
  'Authorization:\r\n  hunter2\r\nsafe source',
])('preserves source line numbers while redacting multiline credentials', (value) => {
  const redacted = scrubSecrets(value);
  expect(redacted).not.toContain('hunter2');
  expect(redacted.split('\n')).toHaveLength(value.split('\n').length);
  expect(redacted.split('\n').at(-1)).toBe('safe source');
});

it('redacts a private key whose END line was cut off', () => {
  const value = 'Found key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEhunter2\nmorekeydata';
  const redacted = scrubSecrets(value);
  expect(redacted).not.toContain('hunter2');
  expect(redacted).not.toContain('morekeydata');
  expect(redacted.startsWith('Found key:\n')).toBe(true);
  expect(redacted.split('\n')).toHaveLength(value.split('\n').length);
});

describe('hasKnownCredential', () => {
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
