// Size trimming for Kubernetes objects handed to the triage engine. managedFields and the
// last-applied annotation repeat the object and add nothing a responder reasons about. Values are
// not redacted: Secret and ConfigMap data and container env values pass through unchanged.

const LAST_APPLIED = 'kubectl.kubernetes.io/last-applied-configuration';

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Drop the two bulky metadata fields on an already-cloned metadata record. */
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
 * Return a deep copy of a Kubernetes object, or an array of them, with every `metadata` node
 * trimmed. Pure and never throws, so a malformed object still flows through triage.
 * @param v - Kubernetes object, list item array, or any JSON value.
 */
export function trimObject(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trimObject);
  if (!isRecord(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const cloned = trimObject(val);
    if (k === 'metadata' && isRecord(cloned)) cleanMetadata(cloned);
    out[k] = cloned;
  }
  return out;
}
