// Secret-exclusion sanitizer for Kubernetes objects handed to the triage engine. The connector's
// generic get/list tools can return any resource, so a Secret's data or a container's inline env
// value would otherwise reach the model and the audit log verbatim (CWE-532). This strips those
// literal values while keeping the shape a human needs to reason about (keys, names, valueFrom).
// Pure and best-effort: it never throws, so a malformed object still flows through triage.

const REDACTED = '[REDACTED]';
const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';
// The three PodSpec container lists. Any of them can carry an inline `env[].value`.
const CONTAINER_KEYS: ReadonlySet<string> = new Set([
  'containers',
  'initContainers',
  'ephemeralContainers',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Replace every value under `key` with the redaction marker, preserving the keys. */
function redactMap(o: Record<string, unknown>, key: string): void {
  const m = o[key];
  if (!isRecord(m)) return;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(m)) out[k] = REDACTED;
  o[key] = out;
}

/**
 * Redact each `env[].value` in one already-cloned container. `valueFrom` references (secretKeyRef,
 * configMapKeyRef) carry no literal, so they stay; the entry `name` stays so the model still knows
 * which variable was set.
 */
function redactContainerEnv(container: Record<string, unknown>): void {
  const env = container.env;
  if (!Array.isArray(env)) return;
  container.env = env.map((e) => (isRecord(e) && 'value' in e ? { ...e, value: REDACTED } : e));
}

/** Drop the two noisy/secret-bearing metadata fields on an already-cloned metadata record. */
function cleanMetadata(md: Record<string, unknown>): void {
  delete md.managedFields;
  const ann = md.annotations;
  if (isRecord(ann) && LAST_APPLIED in ann) {
    const next = { ...ann };
    delete next[LAST_APPLIED];
    md.annotations = next;
  }
}

/**
 * Deep clone with structural scrubbing applied at every nesting level: container env values are
 * redacted (a Deployment template, a CronJob jobTemplate, etc. all reach `containers` here), and
 * every `metadata` node is cleaned. Data-family redaction is kind-gated and handled by the caller.
 */
function walk(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(walk);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    if (CONTAINER_KEYS.has(k) && Array.isArray(val)) {
      out[k] = val.map((c) => {
        const cloned = walk(c);
        if (isRecord(cloned)) redactContainerEnv(cloned);
        return cloned;
      });
    } else if (k === 'metadata' && isRecord(val)) {
      const cloned = walk(val) as Record<string, unknown>;
      cleanMetadata(cloned);
      out[k] = cloned;
    } else {
      out[k] = walk(val);
    }
  }
  return out;
}

/**
 * Return a scrubbed copy of a Kubernetes object. `resourceKind` supplies the kind for list items,
 * which often omit their own `.kind`; a get carries `.kind` itself. Data-family redaction is gated
 * on the kind so a benign `data` map on some CRD is never touched (only Secret and ConfigMap).
 */
export function sanitizeObject(o: unknown, resourceKind?: string): unknown {
  // An array of objects (e.g. a raw list body handed in whole) must have each item kind-gated, not
  // bypass data-redaction via the non-record early return below. Each item is sanitized by its own
  // kind (or the shared resourceKind), so a Secret inside an array is still redacted.
  if (Array.isArray(o)) return o.map((it) => sanitizeObject(it, resourceKind));
  const cloned = walk(o);
  if (!isRecord(cloned)) return cloned;
  const kind = resourceKind ?? asString(cloned.kind);
  if (kind === 'Secret') {
    redactMap(cloned, 'data');
    redactMap(cloned, 'stringData');
  } else if (kind === 'ConfigMap') {
    redactMap(cloned, 'data');
    redactMap(cloned, 'binaryData');
  }
  return cloned;
}
