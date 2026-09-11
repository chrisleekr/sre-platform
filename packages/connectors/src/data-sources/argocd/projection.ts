import { sanitizeObject } from '../../shared/kubernetes/sanitize';
import { obj, str } from '../../values';
import {
  ArgoApiError,
  DENIED_SEGMENTS,
  MAX_CONDITIONS_PER_APPLICATION,
  MAX_HISTORY_PER_APPLICATION,
  STATE_FIELDS,
  type ApplicationScope,
} from './client';

export function effectiveProject(application: unknown): string {
  return str(obj(obj(application).spec).project) ?? 'default';
}

export function applicationIdentity(application: unknown): string | null {
  const raw = obj(application);
  const metadata = obj(raw.metadata);
  const project = effectiveProject(application);
  const namespace = str(metadata.namespace);
  const name = str(metadata.name);
  return namespace && name ? `${project}/${namespace}/${name}` : null;
}

export function matchesScope(
  application: unknown,
  scopes: ApplicationScope[],
  anyNamespace: boolean,
) {
  if (scopes.length === 0) return false;
  const raw = obj(application);
  const metadata = obj(raw.metadata);
  const project = effectiveProject(application);
  const namespace = str(metadata.namespace);
  const name = str(metadata.name);
  return scopes.some(
    (scope) =>
      (scope.project === '*' || scope.project === project) &&
      (scope.name === '*' || scope.name === name) &&
      (!anyNamespace || scope.namespace === '*' || scope.namespace === namespace),
  );
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export function revisions(value: unknown): string[] {
  const raw = obj(value);
  const many = stringArray(raw.revisions);
  return many.length > 0 ? many : str(raw.revision) ? [str(raw.revision)!] : [];
}

export function safeSourceUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (!['git:', 'http:', 'https:', 'oci:', 'ssh:'].includes(url.protocol) || !url.hostname)
      return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    const scp = raw.match(/^[^\s@]+@([a-z0-9.-]+):([^\s?#]+)$/i);
    return scp ? `${scp[1]}:${scp[2]}` : undefined;
  }
}

export function safeHttpUrl(value: unknown): string | undefined {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

export function safeProviderMessage(value: unknown): string | undefined {
  const message = str(value);
  if (!message) return undefined;
  if (
    /[a-z][a-z0-9+.-]*:[^\s]*@/i.test(message) ||
    /[?&#](?:access_?token|api_?key|password|secret|token)=[^\s&#]*/i.test(message)
  )
    return '[sensitive URL omitted]';
  return message;
}

export function projectedSources(value: unknown): Array<Record<string, string>> {
  const raw = obj(value);
  const candidates = Array.isArray(raw.sources)
    ? raw.sources
    : raw.source && typeof raw.source === 'object'
      ? [raw.source]
      : [];
  return candidates.map((candidate) => {
    const source = obj(candidate);
    return Object.fromEntries(
      ['repoURL', 'path', 'targetRevision', 'chart'].flatMap((key) => {
        const sourceValue = key === 'repoURL' ? safeSourceUrl(source[key]) : str(source[key]);
        return sourceValue ? [[key, sourceValue]] : [];
      }),
    );
  });
}

export function projectedConditions(value: unknown): Array<Record<string, string>> {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CONDITIONS_PER_APPLICATION)
    throw new ArgoApiError('argocd condition count exceeds bound', 'backlog');
  return value.map((condition) => {
    const raw = obj(condition);
    return Object.fromEntries(
      ['type', 'message', 'lastTransitionTime'].flatMap((key) => {
        const conditionValue = key === 'message' ? safeProviderMessage(raw[key]) : str(raw[key]);
        return conditionValue ? [[key, conditionValue]] : [];
      }),
    );
  });
}

/**
 * The logs endpoint is a gRPC-gateway server stream: newline-delimited `{"result":{"content":...}}`
 * objects (follow is forced off, so it terminates). Extract each `content`, skip any unparseable or
 * partial line. Fall back to the raw body when nothing parsed (a plain-text variant), then tail to
 * MAX_LOG_CHARS so a huge log cannot exhaust the worker (CWE-400).
 */
export function parseLogStream(body: string, maxChars: number): string {
  const lines: string[] = [];
  for (const raw of body.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const content = obj(obj(JSON.parse(s)).result).content;
      if (typeof content === 'string') lines.push(content);
    } catch {
      // Non-JSON / partial line: skip (fail-soft).
    }
  }
  const joined = lines.length > 0 ? lines.join('\n') : body;
  return joined.length > maxChars ? joined.slice(-maxChars) : joined;
}

/** A parsed value carries a manifest if it (or any array element) has an `apiVersion` or `kind`. */
export function looksLikeManifest(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(looksLikeManifest);
  return v !== null && typeof v === 'object' && ('apiVersion' in v || 'kind' in v);
}

/**
 * Scrub a managed-resources (drift diff) response. Each item's manifest state fields are JSON-encoded
 * k8s manifests that can carry live Secret data; parse each and run the shared Kubernetes
 * secret-exclusion sanitizer (Secret/ConfigMap values and container env values redacted, keys kept).
 * ArgoCD's own hideSecretData has known bypasses (GHSA-3v3m-wc6v-x4x3), so this is the reliable layer.
 *
 * The four known state fields (STATE_FIELDS) are definitely manifests, so an unparseable one is
 * replaced with a marker, never emitted raw (fail-closed). Beyond those, any OTHER string field that
 * itself parses to a manifest-shaped object (carries apiVersion/kind) is scrubbed too, so a future
 * manifest-bearing field cannot silently leak; plain scalar envelope fields
 * (group/version/kind/namespace/name) do not JSON-parse to an object and pass through. Today ArgoCD
 * populates only the four state fields (the deprecated ResourceDiff.diff is a JSON patch, not a
 * manifest, and is left empty), so this generalization is forward-looking defense-in-depth.
 */
export function scrubManagedResources(data: unknown): unknown {
  const known = new Set<string>(STATE_FIELDS);
  const items = obj(data).items;
  if (!Array.isArray(items)) return data;
  const scrubbed = items.map((it) => {
    const item = { ...obj(it) };
    for (const [field, v] of Object.entries(item)) {
      if (typeof v !== 'string' || v === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(v);
      } catch {
        // A known manifest field that will not parse fails closed; a non-manifest scalar is left alone.
        if (known.has(field)) item[field] = '[unparseable manifest omitted]';
        continue;
      }
      if (known.has(field) || looksLikeManifest(parsed)) item[field] = sanitizeObject(parsed);
    }
    return item;
  });
  return { ...obj(data), items: scrubbed };
}

interface AppSummary {
  name: string | undefined;
  namespace: string | undefined;
  project: string | undefined;
  syncStatus: string | undefined;
  healthStatus: string | undefined;
  revisions: string[];
  sources: Array<Record<string, string>>;
  operationPhase: string | undefined;
  operationMessage: string | undefined;
}

/** Reduce an ArgoCD Application to the sync/health headline triage reasons about. */
export function summarizeApp(app: unknown): AppSummary {
  const a = obj(app);
  const meta = obj(a.metadata);
  const spec = obj(a.spec);
  const status = obj(a.status);
  const sync = obj(status.sync);
  const health = obj(status.health);
  const op = obj(status.operationState);
  return {
    name: str(meta.name),
    namespace: str(meta.namespace),
    project: effectiveProject(app),
    syncStatus: str(sync.status),
    healthStatus: str(health.status),
    revisions: revisions(sync),
    sources: projectedSources(spec),
    operationPhase: str(op.phase),
    operationMessage: safeProviderMessage(op.message),
  };
}

export function projectApplicationForInvestigation(application: unknown): Record<string, unknown> {
  const raw = obj(application);
  const metadata = obj(raw.metadata);
  const spec = obj(raw.spec);
  const status = obj(raw.status);
  const sync = obj(status.sync);
  const health = obj(status.health);
  const operation = obj(status.operationState);
  const syncResult = obj(operation.syncResult);
  const history = Array.isArray(status.history) ? status.history : [];
  if (history.length > MAX_HISTORY_PER_APPLICATION)
    throw new ArgoApiError('argocd history count exceeds bound', 'backlog');

  return {
    metadata: {
      name: str(metadata.name),
      namespace: str(metadata.namespace),
      uid: str(metadata.uid),
    },
    spec: {
      project: effectiveProject(application),
      destination: {
        server: str(obj(spec.destination).server),
        namespace: str(obj(spec.destination).namespace),
      },
      sources: projectedSources(spec),
    },
    status: {
      sync: {
        status: str(sync.status),
        revision: str(sync.revision),
        revisions: stringArray(sync.revisions),
      },
      health: { status: str(health.status), message: safeProviderMessage(health.message) },
      conditions: projectedConditions(status.conditions),
      operationState: {
        phase: str(operation.phase),
        message: safeProviderMessage(operation.message),
        startedAt: str(operation.startedAt),
        finishedAt: str(operation.finishedAt),
        syncResult: {
          revision: str(syncResult.revision),
          revisions: stringArray(syncResult.revisions),
          sources: projectedSources(syncResult),
        },
      },
      history: history.map((value) => {
        const entry = obj(value);
        const initiatedBy = obj(entry.initiatedBy);
        return {
          id:
            typeof entry.id === 'number' || typeof entry.id === 'string'
              ? String(entry.id)
              : undefined,
          revision: str(entry.revision),
          revisions: stringArray(entry.revisions),
          sources: projectedSources(entry),
          deployStartedAt: str(entry.deployStartedAt),
          deployedAt: str(entry.deployedAt),
          initiatedBy: {
            username: str(initiatedBy.username),
            automated: initiatedBy.automated === true,
          },
        };
      }),
    },
  };
}

export function apiGetPathIsDenied(base: string, url: string): boolean {
  const basePath = new URL(base.replace(/\/+$/, '') + '/').pathname;
  const pathname = new URL(url).pathname;
  if (!pathname.startsWith(basePath)) return true;
  const segments = pathname.slice(basePath.length).split('/').filter(Boolean);
  if (segments[0] !== 'api' || segments[1] !== 'v1') return true;
  const resource = segments[2];
  const rest = segments.slice(3);
  if (resource === 'applications') return true;
  if (resource === 'clusters' || resource === 'repositories' || resource === 'projects')
    return true;
  return DENIED_SEGMENTS.has(rest.at(-1) ?? '');
}

/** Bind a Zod input schema to a typed run body, returning the erased ConnectorTool (mirror of k8s/prometheus). */
