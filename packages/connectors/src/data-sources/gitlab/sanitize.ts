// Path-gated secret exclusion for GitLab REST responses handed to the triage engine. GitLab has no
// object `kind`, so which fields are secret is decided by the request path — the analog of the
// Kubernetes sanitizer's kind-gating. Redacts values, keeps keys/structure. Pure and best-effort:
// never throws, so a malformed body still flows through triage (sanitize-and-continue).

const REDACTED = '[REDACTED]';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

interface Rule {
  match: RegExp;
  fields: string[];
}

// Path suffix (tested against the full request path) → top-level field VALUES to redact per item.
const RULES: Rule[] = [
  { match: /\/variables(\/|$)/, fields: ['value'] },
  {
    match: /\/(access_tokens|personal_access_tokens|deploy_tokens|triggers)(\/|$)/,
    fields: ['token'],
  },
  { match: /\/hooks(\/|$)/, fields: ['token', 'url'] },
  { match: /\/runners(\/|$)/, fields: ['token'] },
  { match: /\/pipeline_schedules(\/|$)/, fields: ['value'] },
  { match: /^\/api\/v4\/(projects|groups)\/[^/]+\/?$/, fields: ['runners_token'] },
  { match: /\/(impersonation_tokens|tokens)(\/|$)/, fields: ['token'] },
];

/** Redact the named fields wherever they appear (record or array of records), keeping every key. */
function redactFields(v: unknown, fields: ReadonlySet<string>): unknown {
  if (Array.isArray(v)) return v.map((it) => redactFields(it, fields));
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    out[k] = fields.has(k) ? REDACTED : redactFields(val, fields);
  }
  return out;
}

/** Integration/service payloads nest secrets under `properties`; redact every value there. */
function redactProperties(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redactProperties);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (k === 'properties' && isRecord(val)) {
      const p: Record<string, unknown> = {};
      for (const pk of Object.keys(val)) p[pk] = REDACTED;
      out[k] = p;
    } else {
      out[k] = redactProperties(val);
    }
  }
  return out;
}

export function sanitizeGitLab(path: string, body: unknown): unknown {
  try {
    let out = body;
    const fields = new Set<string>();
    for (const rule of RULES) if (rule.match.test(path)) rule.fields.forEach((f) => fields.add(f));
    if (fields.size > 0) out = redactFields(out, fields);
    if (/\/(integrations|services)(\/|$)/.test(path)) out = redactProperties(out);
    return out;
  } catch {
    return body; // best-effort: never block triage on a sanitize failure
  }
}
