import { describe, expect, it } from 'vitest';
import { redactInput, scrubSecrets } from '../redact';

describe('redactInput', () => {
  it('scrubs sensitive keys and preserves benign keys', () => {
    const input = {
      service: 'checkout',
      windowMinutes: 15,
      query: 'db pool',
      k: 5,
      token: 'sk-secret',
      password: 'hunter2',
      secret: 'shh',
      credential: 'cred',
      api_key: 'ak-1',
      apiKey: 'ak-2',
      authorization: 'Bearer xyz',
      auth: 'basic',
      nested: {
        service: 'api',
        password: 'nested-pw',
        deeper: { secret: 'deep-secret', windowMinutes: 30 },
      },
      list: [{ token: 't1', service: 's1' }, { ok: true }],
    };

    // One deep equality covers it all: benign keys pass through, sensitive keys (incl. nested and
    // inside arrays) have their VALUE replaced, the structure is otherwise preserved.
    expect(redactInput(input)).toEqual({
      service: 'checkout',
      windowMinutes: 15,
      query: 'db pool',
      k: 5,
      token: '[REDACTED]',
      password: '[REDACTED]',
      secret: '[REDACTED]',
      credential: '[REDACTED]',
      api_key: '[REDACTED]',
      apiKey: '[REDACTED]',
      authorization: '[REDACTED]',
      auth: '[REDACTED]',
      nested: {
        service: 'api',
        password: '[REDACTED]',
        deeper: { secret: '[REDACTED]', windowMinutes: 30 },
      },
      list: [{ token: '[REDACTED]', service: 's1' }, { ok: true }],
    });

    // The original is not mutated (deep-clone, not in-place).
    expect(input.token).toBe('sk-secret');
    expect(input.nested.deeper.secret).toBe('deep-secret');
  });

  it('redacts camelCase and AWS-style credential keys but not substring look-alikes', () => {
    const input = {
      apiToken: 'a',
      accessToken: 'b',
      sessionToken: 'c',
      accessKey: 'd',
      privateKey: 'e',
      secretKey: 'f',
      aws_secret_access_key: 'g',
      secretAccessKey: 'h',
      clientSecret: 'i',
      bearer: 'j',
      cookie: 'k',
      'x-api-key': 'l',
      // Whole-segment matching must NOT redact substring look-alikes.
      author: 'jane',
      tokenize: true,
      monkey: 'george',
      secretary: 'pat',
      // Benign keys stay intact.
      service: 'checkout',
      windowMinutes: 15,
      query: 'db pool',
      k: 5,
      nested: { sessionToken: 'n', author: 'bob' },
      list: [{ accessKey: 'x', monkey: 'y' }],
    };

    expect(redactInput(input)).toEqual({
      apiToken: '[REDACTED]',
      accessToken: '[REDACTED]',
      sessionToken: '[REDACTED]',
      accessKey: '[REDACTED]',
      privateKey: '[REDACTED]',
      secretKey: '[REDACTED]',
      aws_secret_access_key: '[REDACTED]',
      secretAccessKey: '[REDACTED]',
      clientSecret: '[REDACTED]',
      bearer: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-api-key': '[REDACTED]',
      author: 'jane',
      tokenize: true,
      monkey: 'george',
      secretary: 'pat',
      service: 'checkout',
      windowMinutes: 15,
      query: 'db pool',
      k: 5,
      nested: { sessionToken: '[REDACTED]', author: 'bob' },
      list: [{ accessKey: '[REDACTED]', monkey: 'y' }],
    });
  });

  it('returns non-object input as-is', () => {
    expect(redactInput(5)).toBe(5);
    expect(redactInput('hello')).toBe('hello');
    expect(redactInput(true)).toBe(true);
    expect(redactInput(null)).toBe(null);
    expect(redactInput(undefined)).toBe(undefined);
  });

  it('scrubs secret values embedded in benign free-text fields (example 1)', () => {
    const out = redactInput({ query: 'find logs with Bearer abc.def.ghi123XYZ token' }) as {
      query: string;
    };
    // The benign key `query` is preserved, but the secret in its value is scrubbed.
    expect(out.query).not.toContain('abc.def.ghi123XYZ');
    expect(out.query).toContain('[REDACTED]');
    // Surrounding benign words survive.
    expect(out.query).toContain('find logs with');
    expect(out.query).toContain('token');
  });

  it('leaves a benign free-text value unchanged', () => {
    const input = { query: 'the checkout service returned 500 for /orders' };
    expect(redactInput(input)).toEqual(input);
  });
});

describe('scrubSecrets', () => {
  it('scrubs an AWS access key id', () => {
    const out = scrubSecrets('id AKIAIOSFODNN7EXAMPLE here');
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('id');
    expect(out).toContain('here');
  });

  it('scrubs a Bearer token', () => {
    const out = scrubSecrets('Authorization: Bearer abc.def.ghi123XYZ');
    expect(out).not.toContain('abc.def.ghi123XYZ');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs an OpenAI-style sk- key', () => {
    const out = scrubSecrets('key sk-abcdefghijklmnopqrstuvwx1234');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx1234');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs a JWT', () => {
    const out = scrubSecrets('tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123');
    expect(out).not.toContain('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123');
    expect(out).toContain('[REDACTED]');
  });

  it('scrubs a GitLab personal access token', () => {
    const out = scrubSecrets('glpat-ABCDEF1234567890abcd');
    expect(out).not.toContain('glpat-ABCDEF1234567890abcd');
    expect(out).toContain('[REDACTED]');
  });

  it('leaves benign text unchanged', () => {
    const benign = 'the checkout service returned 500 for /orders';
    expect(scrubSecrets(benign)).toBe(benign);
  });

  it('scrubs a long high-entropy run', () => {
    const out = scrubSecrets('raw Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2');
    expect(out).not.toContain('Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2');
    expect(out).toContain('[REDACTED]');
  });

  it('preserves a UUID (not a secret)', () => {
    const withUuid = 'order-00000000-0000-0000-0000-000000000000';
    expect(scrubSecrets(withUuid)).toContain('00000000-0000-0000-0000-000000000000');
  });

  it('scrubs bounded sensitive assignments', () => {
    const raw =
      'password=hunter2 token: "plain-secret" DATABASE_URL=hidden access_token=short-value refreshToken=rv-value client-secret=cv-value AWS_SECRET_ACCESS_KEY=ak-value';
    const out = scrubSecrets(raw);
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('plain-secret');
    expect(out).not.toContain('hidden');
    expect(out).not.toContain('short-value');
    expect(out).not.toContain('rv-value');
    expect(out).not.toContain('cv-value');
    expect(out).not.toContain('ak-value');
    expect(out).toContain('password=[REDACTED]');
    expect(out).toContain('DATABASE_URL=[REDACTED]');
  });

  it.each([
    'Authorization: Basic YWxpY2U6c2VjcmV0',
    'Proxy-Authorization: Digest opaque-value',
    'Cookie: session=plain-cookie',
    'Set-Cookie: refresh=plain-cookie',
  ])('scrubs the complete sensitive header value: %s', (header) => {
    const out = scrubSecrets(header);
    expect(out).toMatch(/^[A-Za-z-]+: \[REDACTED\]$/);
    expect(out).not.toContain(header.split(': ')[1]!);
  });

  it('scrubs connection URL passwords while retaining the endpoint', () => {
    const out = scrubSecrets('postgres://alice:secret@db.example/app');
    expect(out).toBe('postgres://alice:[REDACTED]@db.example/app');
  });

  it('scrubs complete PEM private-key blocks', () => {
    const privateKey = [
      ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
      'not-a-high-entropy-but-still-secret-line',
      ['-----END RSA', 'PRIVATE KEY-----'].join(' '),
    ].join('\n');
    const out = scrubSecrets(`failure included ${privateKey} after`);
    expect(out).not.toContain('not-a-high-entropy-but-still-secret-line');
    expect(out).toBe('failure included [REDACTED] after');
  });
});
