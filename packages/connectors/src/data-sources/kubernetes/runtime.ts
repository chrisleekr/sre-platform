import type { ConnectorConfig } from '../../registry';
import { assertSafeHttpsUrl, dnsLookup, type HostLookup } from '../../ssrf';
import type { NormalizedSnapshot, RuntimeArtifact } from '../../types';
import { obj, str } from '../../values';

type FetchLike = typeof fetch;

/**
 * A non-2xx API-server response. Carries the status so callers can branch (e.g. a metrics 404 means
 * metrics-server is not installed, not a failure) while keeping the `k8s api <status>` message.
 */
export class K8sApiError extends Error {
  constructor(readonly status: number) {
    super(`k8s api ${status}`);
    this.name = 'K8sApiError';
  }
}

/**
 * Bun's fetch accepts a `tls` option that the DOM/Node `RequestInit` does not declare. Extend it
 * locally rather than reach for `any`; a value of this type is still assignable to `RequestInit`.
 */
interface K8sFetchInit extends RequestInit {
  tls?: { ca?: string; rejectUnauthorized?: boolean };
}

const PRESSURE_TYPES: ReadonlySet<string> = new Set([
  'MemoryPressure',
  'DiskPressure',
  'PIDPressure',
]);
interface ContainerHealth {
  name: string | undefined;
  image: string | undefined;
  imageId: string | undefined;
  ready: boolean;
  restartCount: number;
  terminatedReason: string | undefined;
  waitingReason: string | undefined;
  lastTerminatedReason: string | undefined;
  lastTerminatedAt: string | undefined;
}

interface PodHealth {
  name: string | undefined;
  phase: string | undefined;
  restarts: number;
  oomKilled: boolean;
  ready: boolean;
  containers: ContainerHealth[];
}

interface NodeHealth {
  name: string | undefined;
  ready: boolean;
  pressures: string[];
}

function declaredSourceUrl(value: unknown): string | null {
  const source = str(value);
  if (!source) return null;
  try {
    const parsed = new URL(source);
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) || parsed.password)
      return null;
    if (['http:', 'https:'].includes(parsed.protocol) && parsed.username) return null;
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    const scp = source.match(/^[^@\s]+@([^:\s]+):([^\s?#]+)$/);
    if (!scp) return null;
    try {
      return new URL(`ssh://${scp[1]}/${scp[2]}`).toString();
    } catch {
      return null;
    }
  }
}

function declaredRevision(value: unknown): string | null {
  const revision = str(value);
  return revision && /^[0-9a-f]{40,64}$/i.test(revision) ? revision.toLowerCase() : null;
}

/** Per-container status: readiness, restarts, and the reasons behind a crash or a stuck start. */
function mapContainer(raw: unknown): ContainerHealth {
  const cs = obj(raw);
  const state = obj(cs.state);
  const lastState = obj(cs.lastState);
  const lastTermination = obj(lastState.terminated);
  return {
    name: str(cs.name),
    image: str(cs.image),
    imageId: str(cs.imageID),
    ready: cs.ready === true,
    restartCount: typeof cs.restartCount === 'number' ? cs.restartCount : 0,
    terminatedReason: str(obj(state.terminated).reason),
    waitingReason: str(obj(state.waiting).reason),
    lastTerminatedReason: str(lastTermination.reason),
    lastTerminatedAt: str(lastTermination.finishedAt),
  };
}

export function runtimeArtifacts(
  config: ConnectorConfig,
  service: string,
  pods: unknown[],
): RuntimeArtifact[] {
  const observedAt = new Date().toISOString();
  return pods.flatMap((raw) => {
    const pod = obj(raw);
    const metadata = obj(pod.metadata);
    const labels = obj(metadata.labels);
    const annotations = obj(metadata.annotations);
    const status = obj(pod.status);
    if (str(status.phase) !== 'Running') return [];
    const statuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
    const workload = str(metadata.name) ?? null;
    // Kubernetes has no enforceable service ownership model. Only the recommended application-name
    // label is precise enough for bounded candidate evidence; configured catalog mappings remain
    // authoritative when code intelligence ranks repositories.
    if (str(labels['app.kubernetes.io/name']) !== service) return [];
    return statuses.flatMap((candidate) => {
      const container = obj(candidate);
      const name = str(container.name);
      const image = str(container.image) ?? null;
      const imageId = str(container.imageID) ?? null;
      const identity = imageId ?? image;
      if (!name || !identity) return [];
      const digest = /sha256:[0-9a-f]{64}/i.exec(identity)?.[0]?.toLowerCase() ?? null;
      const sourceUrl = declaredSourceUrl(annotations['org.opencontainers.image.source']);
      const revision = declaredRevision(annotations['org.opencontainers.image.revision']);
      return [
        {
          dataSourceId: config.id,
          dataSourceName: config.name,
          kind: 'oci_image' as const,
          service,
          namespace: str(metadata.namespace) ?? 'default',
          workload,
          container: name,
          image,
          identity,
          digest,
          sourceUrl,
          revision,
          // Kubernetes exposes Pod annotations here. They are deployment declarations, not OCI
          // manifest metadata read from the immutable image digest.
          provenance: sourceUrl || revision ? ('declared' as const) : null,
          observedAt,
        },
      ];
    });
  });
}

export function mapPod(raw: unknown): PodHealth {
  const p = obj(raw);
  const metadata = obj(p.metadata);
  const status = obj(p.status);
  const containerStatuses = Array.isArray(status.containerStatuses) ? status.containerStatuses : [];
  const containers = containerStatuses.map(mapContainer);
  return {
    name: str(metadata.name),
    phase: str(status.phase),
    restarts: containers.reduce((max, c) => Math.max(max, c.restartCount), 0),
    oomKilled: containers.some((container) => container.terminatedReason === 'OOMKilled'),
    // A pod is ready only when it has containers and every one of them is ready.
    ready: containers.length > 0 && containers.every((c) => c.ready),
    containers,
  };
}

export function mapNode(raw: unknown): NodeHealth {
  const n = obj(raw);
  const status = obj(n.status);
  const conditions = Array.isArray(status.conditions) ? status.conditions : [];
  let ready = false;
  const pressures: string[] = [];
  for (const c of conditions) {
    const cond = obj(c);
    const type = str(cond.type);
    const ok = cond.status === 'True';
    if (type === 'Ready') ready = ok;
    if (type && ok && PRESSURE_TYPES.has(type)) pressures.push(type);
  }
  return { name: str(obj(n.metadata).name), ready, pressures };
}

/** A Warning event, flattened to the fields triage cares about. */
export function mapEvent(raw: unknown) {
  const e = obj(raw);
  const involved = obj(e.involvedObject);
  return {
    reason: str(e.reason),
    message: str(e.message),
    object: `${str(involved.kind) ?? '?'}/${str(involved.name) ?? '?'}`,
    at: str(e.lastTimestamp) ?? str(e.eventTime),
  };
}

/**
 * Keep an event when its timestamp is within the window. A missing or unparseable timestamp is
 * kept (not silently dropped) so a malformed event still surfaces for a human to judge.
 */
export function withinWindow(at: string | undefined, windowMinutes: number): boolean {
  if (!at) return true;
  const t = Date.parse(at);
  if (Number.isNaN(t)) return true;
  return Date.now() - t <= windowMinutes * 60_000;
}

/** Bun fetch `tls` options from connector settings: CA-pinning, else the insecure escape hatch. */
function buildTls(settings: Record<string, unknown>): K8sFetchInit['tls'] {
  const caCert = str(settings.caCert);
  if (caCert) return { ca: caCert };
  if (settings.insecureSkipTLSVerify === true) return { rejectUnauthorized: false };
  return undefined;
}

/**
 * Literal loopback / link-local / RFC1918 host, or an in-cluster service name. On such a host system
 * trust cannot prove the target is the tenant's real cluster, so a CA pin (or explicit insecure
 * opt-in) is required: this is what confines the allowed-private-host path.
 *
 * In-cluster names are included because they always resolve into private space, and because
 * monitoring the cluster the platform runs in is a supported setup. Without them the caller is
 * offered system trust and the handshake fails against the cluster CA with nothing naming trust as
 * the cause. Other DNS names resolving into private space are still not caught here; the
 * resolve-and-validate SSRF check and the deployment's egress policy cover those.
 */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1') return true;
  if (h.startsWith('127.')) return true;
  if (h.startsWith('169.254.')) return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h === 'kubernetes' || h === 'kubernetes.default') return true;
  return h.endsWith('.svc') || h.endsWith('.svc.cluster.local');
}

/**
 * Validate the tenant's apiUrl (https + resolve-and-validate SSRF) and return the confined base URL.
 * Extracted so every read path (client construction) inherits the same TLS trust and SSRF
 * confinement: a disallowed apiUrl fails identically everywhere.
 *
 * `allowPrivate` admits a private or in-cluster control plane, which is the normal deployment, while
 * still refusing loopback, unspecified, 169.254 metadata, and IPv6 link-local. The literal-host CA
 * requirement below is a separate concern (trust, not reachability) and stays.
 */
async function validateApiBase(
  settings: Record<string, unknown>,
  lookup: HostLookup,
): Promise<string> {
  const apiUrl = str(settings.apiUrl);
  if (!apiUrl) throw new Error('kubernetes connector: apiUrl is required');
  let parsed: URL;
  try {
    parsed = new URL(apiUrl);
  } catch {
    throw new Error('kubernetes connector: invalid apiUrl');
  }
  // Require https: the API-server token and pod internals are sensitive, and CA-pinning only
  // defends a TLS connection. A plaintext or file: URL is a misconfiguration, not a target.
  if (parsed.protocol !== 'https:') {
    throw new Error('kubernetes connector: apiUrl must be https');
  }
  const caCert = str(settings.caCert);
  const insecure = settings.insecureSkipTLSVerify === true;
  // A private control plane is allowed, but on a private host system trust cannot prove the target
  // is the tenant's real cluster, so require a pinned CA (or an explicit insecure opt-in). This is
  // the trust half; the SSRF half is the resolve-and-validate call below.
  if (isPrivateHost(parsed.hostname) && !caCert && !insecure) {
    throw new Error(
      'kubernetes connector: a private apiUrl requires caCert (or insecureSkipTLSVerify)',
    );
  }
  // Resolve-and-validate every address the host answers with (CWE-918). Without this a DNS name
  // that resolves into always-dangerous space, notably the 169.254.169.254 metadata endpoint, is
  // invisible to the literal-host check above and would receive the bearer token.
  await assertSafeHttpsUrl(apiUrl, lookup, { allowPrivate: true });
  return apiUrl.replace(/\/+$/, '');
}

/**
 * A bearer-authenticated client confined to the tenant's cluster API. Three read shapes share the
 * same init (Authorization header, pinned TLS, 8s timeout, redirect:error):
 * - `kjson` parses JSON and throws `K8sApiError` on non-2xx (the strict path);
 * - `ktext` returns the raw body (pod logs) with the same throw-on-error guard;
 * - `kstat` returns the status code without throwing (the probe path, which must distinguish
 *   200/401/403/404); a network/timeout error still rejects.
 * Shared by `fetchTriageContext`, `snapshot`, the generic tools, and `probeKubernetes`.
 */
export async function k8sClient(
  config: ConnectorConfig,
  fetchImpl: FetchLike,
  lookup: HostLookup = dnsLookup,
): Promise<{
  kjson: (path: string) => Promise<unknown>;
  ktext: (path: string) => Promise<string>;
  kstat: (path: string) => Promise<number>;
}> {
  // A missing secret throws here and propagates (runTool degrades to error, never a fake read).
  const token = await config.getCredential();
  const base = await validateApiBase(config.settings, lookup);
  const tls = buildTls(config.settings);

  const doFetch = (path: string): Promise<Response> => {
    const init: K8sFetchInit = {
      // Token rides the Authorization header, never the URL, so it cannot leak via error text.
      headers: { Authorization: `Bearer ${token}` },
      tls,
      // fetch has no default timeout; bound the request so a dead API server cannot hang the
      // engine loop and worker slot (CWE-400).
      signal: AbortSignal.timeout(8000),
      // A 3xx could otherwise bounce the bearer token to an attacker-chosen host.
      redirect: 'error',
    };
    return fetchImpl(`${base}${path}`, init);
  };

  return {
    kjson: async (path) => {
      const res = await doFetch(path);
      if (!res.ok) throw new K8sApiError(res.status);
      return res.json();
    },
    ktext: async (path) => {
      const res = await doFetch(path);
      if (!res.ok) throw new K8sApiError(res.status);
      return res.text();
    },
    // No throw on a non-2xx: the probe reads the status to classify reachability and authorization.
    kstat: async (path) => (await doFetch(path)).status,
  };
}

/** The `.items` array of a list response, or [] when the shape is unexpected. */
export function itemsOf(v: unknown): unknown[] {
  const items = (v as { items?: unknown }).items;
  return Array.isArray(items) ? items : [];
}

/** One pod's polled health as a NormalizedSnapshot: numeric signals in `metrics`, detail in `metadata`. */
export function podSnapshot(
  tenantId: string,
  configuredNamespace: string | undefined,
  raw: unknown,
  observedAt: Date,
): NormalizedSnapshot {
  const pod = mapPod(raw);
  const namespace = str(obj(obj(raw).metadata).namespace) ?? configuredNamespace;
  const name = pod.name ?? 'unknown';
  return {
    tenantId,
    source: 'kubernetes',
    // Pod names are unique only within a namespace. The normalized id must remain unique when a
    // connector monitors the whole cluster, and the qualified form is also clearer in the dashboard.
    entityId: `${namespace ?? 'unknown'}/${name}`,
    metrics: {
      restartCount: pod.restarts,
      ready: pod.ready ? 1 : 0,
      oomKilled: pod.oomKilled ? 1 : 0,
    },
    metadata: { kind: 'pod', namespace, phase: pod.phase, containers: pod.containers },
    observedAt,
  };
}

/** One node's polled health as a NormalizedSnapshot. */
export function nodeSnapshot(tenantId: string, raw: unknown, observedAt: Date): NormalizedSnapshot {
  const node = mapNode(raw);
  return {
    tenantId,
    source: 'kubernetes',
    entityId: node.name ?? 'unknown',
    metrics: { ready: node.ready ? 1 : 0, pressures: node.pressures.length },
    metadata: { kind: 'node', pressures: node.pressures },
    observedAt,
  };
}
