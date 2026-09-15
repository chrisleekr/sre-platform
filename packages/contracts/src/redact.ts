const SENSITIVE_SEGMENTS = new Set([
  'token',
  'password',
  'passwd',
  'pwd',
  'pass',
  'passphrase',
  'secret',
  'credential',
  'credentials',
  'key',
  'apikey',
  'authorization',
  'auth',
  'bearer',
  'cookie',
  'session',
  'signature',
  'pat',
  'pin',
  'otp',
]);
const SENSITIVE_COMPOUND_KEYS = new Set(['databaseurl', 'databaseuri', 'connectionstring']);
const REDACTED = '[REDACTED]';

/**
 * Reports whether a key name (header, query parameter, object key) denotes a credential.
 * @param key - Key name in any casing or separator style.
 */
export function isSensitiveKey(key: string): boolean {
  const segments = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((segment) => segment.toLowerCase());
  return (
    segments.some((segment) => SENSITIVE_SEGMENTS.has(segment)) ||
    SENSITIVE_COMPOUND_KEYS.has(segments.join(''))
  );
}

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
  /A(?:KIA|SIA)[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
];
const KEY_VALUE_ASSIGNMENT =
  /\b([A-Za-z][A-Za-z0-9_.-]{1,80})(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/g;
// Matches the header line plus any RFC 9112 5.2 obs-fold continuation, which must begin with a
// space or tab. Folding is deprecated but this scrubs pasted logs, not parsed HTTP, so a value
// living entirely on the next line has to be redacted with its header. Every repetition here is
// separated from its neighbour by a character the neighbour cannot match, so the scan is linear.
// Over-redacting an indented following line is the safe direction for a credential scrubber.
const SENSITIVE_HEADER =
  /^(Authorization|Proxy-Authorization|Cookie|Set-Cookie)[^\S\r\n]*:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*/gim;
const CONNECTION_URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@]+)@/gi;
const HIGH_ENTROPY = /\b[A-Za-z0-9]{32,}\b/g;
const looksLikeToken = (run: string): boolean =>
  /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);

/**
 * Removes recognized credentials and high-entropy tokens without shifting source line numbers.
 * @param value - Untrusted text that may contain a credential.
 */
export function scrubSecrets(value: string): string {
  const replace = (match: string, replacement: string) =>
    replacement +
    '\n'.repeat(
      Math.max(0, (match.match(/\n/g)?.length ?? 0) - (replacement.match(/\n/g)?.length ?? 0)),
    );
  let scrubbed = value.replace(SENSITIVE_HEADER, (match, header: string) =>
    replace(match, `${header}: ${REDACTED}`),
  );
  for (const pattern of SECRET_PATTERNS)
    scrubbed = scrubbed.replace(pattern, (match) => replace(match, REDACTED));
  scrubbed = scrubbed.replace(KEY_VALUE_ASSIGNMENT, (match, key: string, separator: string) =>
    isSensitiveKey(key) ? replace(match, `${key}${separator}${REDACTED}`) : match,
  );
  scrubbed = scrubbed.replace(CONNECTION_URL_USERINFO, (match, scheme: string, username: string) =>
    replace(match, `${scheme}${username}:${REDACTED}@`),
  );
  return scrubbed.replace(HIGH_ENTROPY, (match) => (looksLikeToken(match) ? REDACTED : match));
}

const resetAndTest = (pattern: RegExp, value: string): boolean => {
  // Global regexes carry lastIndex between calls; reset so a prior test cannot skip a match.
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
};

/**
 * Reports whether text contains a recognized credential without applying the entropy heuristic.
 * @param value - Untrusted text to inspect.
 */
export function hasKnownCredential(value: string): boolean {
  // Sensitive header, vendor token, connection-URL userinfo, or a key=value pair with a sensitive
  // key. HIGH_ENTROPY is excluded on purpose: a long opaque id such as a document id is not a
  // credential, and a refuse-or-accept caller cannot absorb that false positive the way a
  // redacting caller can.
  if (resetAndTest(SENSITIVE_HEADER, value) || resetAndTest(CONNECTION_URL_USERINFO, value))
    return true;
  if (SECRET_PATTERNS.some((pattern) => resetAndTest(pattern, value))) return true;
  KEY_VALUE_ASSIGNMENT.lastIndex = 0;
  for (const match of value.matchAll(KEY_VALUE_ASSIGNMENT)) {
    if (isSensitiveKey(match[1] as string)) return true;
  }
  return false;
}

/**
 * Recursively redacts sensitive keys and secret-like string values.
 * @param input - Untrusted structured input.
 */
export function redactInput(input: unknown): unknown {
  if (typeof input === 'string') return scrubSecrets(input);
  if (Array.isArray(input)) return input.map(redactInput);
  if (input === null || typeof input !== 'object') return input;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = isSensitiveKey(key) ? REDACTED : redactInput(value);
  }
  return output;
}
