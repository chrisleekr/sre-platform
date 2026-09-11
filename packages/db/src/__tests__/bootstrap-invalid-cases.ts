interface InvalidCaseFixture {
  provider: {
    displayName: string;
    issuer: string;
    browserClientId: string;
    audience: string;
    emailClaim?: string;
    jwksUri?: string;
  };
  subjectAdmin: { subject: string; email: string };
  emailAdmin: { email: string };
}

export interface BootstrapCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BootstrapMarkerCounts {
  providers: number;
  users: number;
  operators: number;
  invitations: number;
  memberships: number;
}

export interface InvalidBootstrapCase {
  name: string;
  env: (value: InvalidCaseFixture) => Record<string, string | undefined>;
  message: string;
}

function bootstrapEnv(
  value: InvalidCaseFixture,
  admins: readonly unknown[] = [value.subjectAdmin, value.emailAdmin],
): Record<string, string | undefined> {
  return {
    BOOTSTRAP_STAFF_PROVIDER: JSON.stringify(value.provider),
    BOOTSTRAP_PLATFORM_ADMINS: JSON.stringify(admins),
  };
}

export const INVALID_BOOTSTRAP_CASES: InvalidBootstrapCase[] = [
  {
    name: 'missing provider',
    env: (value) => ({ BOOTSTRAP_PLATFORM_ADMINS: JSON.stringify([value.emailAdmin]) }),
    message: 'Missing required env: BOOTSTRAP_STAFF_PROVIDER',
  },
  {
    name: 'blank provider',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_STAFF_PROVIDER: '  ' }),
    message: 'Missing required env: BOOTSTRAP_STAFF_PROVIDER',
  },
  {
    name: 'malformed provider JSON',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_STAFF_PROVIDER: '{' }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER: not valid JSON',
  },
  {
    name: 'provider array',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_STAFF_PROVIDER: '[]' }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER: expected an object',
  },
  {
    name: 'provider unknown key',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...value.provider, clientSecret: 'forbidden' }),
    }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER: unexpected key "clientSecret"',
  },
  {
    name: 'empty provider field',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...value.provider, audience: '' }),
    }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER.audience: expected a non-empty string',
  },
  {
    name: 'non-string provider field',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...value.provider, browserClientId: 42 }),
    }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER.browserClientId: expected a non-empty string',
  },
  {
    name: 'insecure issuer',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        issuer: 'http://idp.internal',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
  },
  {
    name: 'issuer without hostname',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({ ...value.provider, issuer: 'not-a-url' }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
  },
  {
    name: 'issuer credentials',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        issuer: 'https://user:password@idp.internal/',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
  },
  {
    name: 'issuer query',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        issuer: 'https://idp.internal/?v=1',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
  },
  {
    name: 'issuer fragment',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        issuer: 'https://idp.internal/#fragment',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: expected an HTTPS URL without credentials, query, or fragment',
  },
  {
    name: 'JWKS credentials',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        jwksUri: 'https://user:password@keys.internal/jwks',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.jwksUri: expected an HTTPS URL without credentials or fragment',
  },
  {
    name: 'insecure JWKS URI',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        jwksUri: 'http://keys.internal/jwks',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.jwksUri: expected an HTTPS URL without credentials or fragment',
  },
  {
    name: 'JWKS fragment',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        jwksUri: 'https://keys.internal/jwks#fragment',
      }),
    }),
    message:
      'Invalid BOOTSTRAP_STAFF_PROVIDER.jwksUri: expected an HTTPS URL without credentials or fragment',
  },
  {
    name: 'missing administrators',
    env: (value) => ({ BOOTSTRAP_STAFF_PROVIDER: JSON.stringify(value.provider) }),
    message: 'Missing required env: BOOTSTRAP_PLATFORM_ADMINS',
  },
  {
    name: 'blank administrators',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_PLATFORM_ADMINS: '  ' }),
    message: 'Missing required env: BOOTSTRAP_PLATFORM_ADMINS',
  },
  {
    name: 'malformed administrators JSON',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_PLATFORM_ADMINS: '[' }),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS: not valid JSON',
  },
  {
    name: 'administrators object',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_PLATFORM_ADMINS: '{}' }),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS: expected a JSON array',
  },
  {
    name: 'empty administrators array',
    env: (value) => ({ ...bootstrapEnv(value), BOOTSTRAP_PLATFORM_ADMINS: '[]' }),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS: expected at least one entry',
  },
  {
    name: 'administrator is not an object',
    env: (value) => bootstrapEnv(value, ['nope']),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0]: expected an object',
  },
  {
    name: 'administrator has no identity',
    env: (value) => bootstrapEnv(value, [{}]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0]: expected subject or email',
  },
  {
    name: 'administrator unknown key',
    env: (value) => bootstrapEnv(value, [{ ...value.emailAdmin, role: 'owner' }]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0]: unexpected key "role"',
  },
  {
    name: 'blank subject',
    env: (value) => bootstrapEnv(value, [{ subject: ' ', email: value.subjectAdmin.email }]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0].subject: expected a non-empty string',
  },
  {
    name: 'blank email',
    env: (value) => bootstrapEnv(value, [{ email: ' ' }]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0].email: expected a non-empty string',
  },
  {
    name: 'issuer control character',
    env: (value) => ({
      ...bootstrapEnv(value),
      BOOTSTRAP_STAFF_PROVIDER: JSON.stringify({
        ...value.provider,
        issuer: `https://idp.internal/${String.fromCharCode(0)}tail`,
      }),
    }),
    message: 'Invalid BOOTSTRAP_STAFF_PROVIDER.issuer: control characters are not allowed',
  },
  {
    name: 'subject control character',
    env: (value) => bootstrapEnv(value, [{ subject: 'subject\nsecond-line' }]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0].subject: control characters are not allowed',
  },
  {
    name: 'email control character',
    env: (value) =>
      bootstrapEnv(value, [{ email: `operator${String.fromCharCode(127)}@example.invalid` }]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[0].email: control characters are not allowed',
  },
  {
    name: 'duplicate subject',
    env: (value) => bootstrapEnv(value, [value.subjectAdmin, value.subjectAdmin]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[1]: duplicate subject, same as entry 0',
  },
  {
    name: 'duplicate email-only administrator',
    env: (value) => bootstrapEnv(value, [value.emailAdmin, value.emailAdmin]),
    message: 'Invalid BOOTSTRAP_PLATFORM_ADMINS[1]: duplicate email, same as entry 0',
  },
];
