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
  /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/g,
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
const SENSITIVE_HEADER = /^(Authorization|Proxy-Authorization|Cookie|Set-Cookie)[^\S\r\n]*:/im;
const CONNECTION_URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s@]+)@/gi;
const HIGH_ENTROPY = /\b[A-Za-z0-9]{32,}\b/g;

/**
 * Reports whether text contains a 32+ character run mixing lower case, upper case and digits.
 * Only for identifiers that never legitimately carry such a run, such as incident tags.
 * @param value - Untrusted text to inspect.
 */
export function hasHighEntropyToken(value: string): boolean {
  return [...value.matchAll(HIGH_ENTROPY)].some(
    ([run]) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run),
  );
}

const resetAndTest = (pattern: RegExp, value: string): boolean => {
  // Global regexes carry lastIndex between calls; reset so a prior test cannot skip a match.
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
};

/**
 * Reports whether text contains a recognized credential. Callers refuse such text as an identifier.
 * @param value - Untrusted text to inspect.
 */
export function hasKnownCredential(value: string): boolean {
  // Sensitive header, vendor token, connection-URL userinfo, or a key=value pair with a sensitive
  // key. No entropy heuristic: a long opaque id such as a document id is not a credential, and a
  // refuse-or-accept caller cannot absorb that false positive.
  if (resetAndTest(SENSITIVE_HEADER, value) || resetAndTest(CONNECTION_URL_USERINFO, value))
    return true;
  if (SECRET_PATTERNS.some((pattern) => resetAndTest(pattern, value))) return true;
  KEY_VALUE_ASSIGNMENT.lastIndex = 0;
  for (const match of value.matchAll(KEY_VALUE_ASSIGNMENT)) {
    if (isSensitiveKey(match[1] as string)) return true;
  }
  return false;
}
