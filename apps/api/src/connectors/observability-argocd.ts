import { PromCreds, alertmanagerEventToken, alertmanagerSmeeUrl } from '@sre/connectors';
import {
  argoCdUrlError,
  EPISODE_GROUPING_WINDOW_DEFAULT_SEC,
  EPISODE_GROUPING_WINDOW_MAX_SEC,
  EPISODE_GROUPING_WINDOW_MIN_SEC,
  INCIDENT_MAX_AGE_DEFAULT_SEC,
  INCIDENT_MAX_AGE_MAX_SEC,
  INCIDENT_MAX_AGE_MIN_SEC,
} from '@sre/contracts';
import {
  PROMETHEUS_AUTH_TYPES,
  type ArgoCdProjectApplicationScope,
  type ArgoCdProjectBinding,
  type ArgoCdSettings,
  type PrometheusAuthType,
  type PrometheusSettings,
} from './contracts';
import { requestObject } from './shared';

export const DATADOG_SITES = new Set([
  'datadoghq.com',
  'us3.datadoghq.com',
  'us5.datadoghq.com',
  'datadoghq.eu',
  'ap1.datadoghq.com',
  'ap2.datadoghq.com',
  'uk1.datadoghq.com',
  'ddog-gov.com',
  'us2.ddog-gov.com',
]);

export function parseDatadogSettings(input: unknown): { site: string } | null {
  const raw = requestObject(input);
  const site = typeof raw?.site === 'string' ? raw.site.trim() : '';
  return DATADOG_SITES.has(site) ? { site } : null;
}

export function parseDatadogCredential(input: string): string | null {
  if (input.length > 16 * 1024) return null;
  try {
    const raw = requestObject(JSON.parse(input));
    const apiKey = typeof raw?.apiKey === 'string' ? raw.apiKey.trim() : '';
    const appKey = typeof raw?.appKey === 'string' ? raw.appKey.trim() : '';
    if (!apiKey || !appKey || /[\r\n]/.test(apiKey) || /[\r\n]/.test(appKey)) return null;
    return JSON.stringify({ apiKey, appKey });
  } catch {
    return null;
  }
}

export interface GrafanaSettings {
  baseUrl: string;
  caCert?: string;
  insecureSkipTLSVerify?: boolean;
}

export function parseGrafanaSettings(input: unknown): GrafanaSettings | null {
  const raw = requestObject(input);
  if (!raw || typeof raw.baseUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.baseUrl.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  if (raw.caCert !== undefined && typeof raw.caCert !== 'string') return null;
  const caCert = typeof raw.caCert === 'string' ? raw.caCert.trim() : undefined;
  if (caCert && caCert.length > 128 * 1024) return null;
  if (raw.insecureSkipTLSVerify !== undefined && typeof raw.insecureSkipTLSVerify !== 'boolean')
    return null;
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, '')}`,
    ...(caCert ? { caCert } : {}),
    ...(raw.insecureSkipTLSVerify === true ? { insecureSkipTLSVerify: true } : {}),
  };
}

export function publicGrafanaSettings(input: unknown): Record<string, unknown> {
  const parsed = parseGrafanaSettings(input);
  if (!parsed) return {};
  const { caCert, ...visible } = parsed;
  return { ...visible, ...(caCert ? { caConfigured: true } : {}) };
}

export const FORBIDDEN_PROMETHEUS_HEADERS = new Set([
  'authorization',
  'connection',
  'content-length',
  'cookie',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function parsePrometheusSettings(input: unknown): PrometheusSettings | null {
  const raw = requestObject(input);
  if (!raw || typeof raw.baseUrl !== 'string' || typeof raw.authType !== 'string') return null;
  let url: URL;
  try {
    url = new URL(raw.baseUrl.trim());
  } catch {
    return null;
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && raw.authType === 'mtls') ||
    !PROMETHEUS_AUTH_TYPES.includes(raw.authType as PrometheusAuthType)
  )
    return null;
  const caCert = typeof raw.caCert === 'string' ? raw.caCert.trim() : undefined;
  if (raw.caCert !== undefined && typeof raw.caCert !== 'string') return null;
  if (caCert && caCert.length > 128 * 1024) return null;
  if (raw.insecureSkipTLSVerify !== undefined && typeof raw.insecureSkipTLSVerify !== 'boolean')
    return null;
  const eventTransport = raw.eventTransport ?? 'none';
  if (eventTransport !== 'direct' && eventTransport !== 'smee' && eventTransport !== 'none')
    return null;
  const alertChannel = typeof raw.alertChannel === 'string' ? raw.alertChannel.trim() : undefined;
  if (eventTransport !== 'none' && (!alertChannel || !/^[CGD][A-Z0-9]{1,255}$/.test(alertChannel)))
    return null;
  const cohortWindowSec = raw.cohortWindowSec === undefined ? 120 : Number(raw.cohortWindowSec);
  if (!Number.isInteger(cohortWindowSec) || cohortWindowSec < 30 || cohortWindowSec > 600)
    return null;
  const episodeGroupingWindowSec =
    raw.episodeGroupingWindowSec === undefined
      ? EPISODE_GROUPING_WINDOW_DEFAULT_SEC
      : Number(raw.episodeGroupingWindowSec);
  if (
    !Number.isInteger(episodeGroupingWindowSec) ||
    episodeGroupingWindowSec < EPISODE_GROUPING_WINDOW_MIN_SEC ||
    episodeGroupingWindowSec > EPISODE_GROUPING_WINDOW_MAX_SEC
  )
    return null;
  const maxIncidentAgeSec =
    raw.maxIncidentAgeSec === undefined
      ? INCIDENT_MAX_AGE_DEFAULT_SEC
      : Number(raw.maxIncidentAgeSec);
  if (
    !Number.isInteger(maxIncidentAgeSec) ||
    maxIncidentAgeSec < INCIDENT_MAX_AGE_MIN_SEC ||
    maxIncidentAgeSec > INCIDENT_MAX_AGE_MAX_SEC ||
    maxIncidentAgeSec < episodeGroupingWindowSec
  )
    return null;
  const path = url.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${url.origin}${path}`,
    authType: raw.authType as PrometheusAuthType,
    ...(caCert ? { caCert } : {}),
    ...(raw.insecureSkipTLSVerify === true ? { insecureSkipTLSVerify: true } : {}),
    eventTransport,
    ...(alertChannel ? { alertChannel } : {}),
    cohortWindowSec,
    episodeGroupingWindowSec,
    maxIncidentAgeSec,
  };
}

export function parsePrometheusCredential(value: string): string | null {
  if (value.length > 256 * 1024) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const result = PromCreds.safeParse(parsed);
  if (!result.success) return null;
  const hasHeaderControl = (input: string): boolean => input.includes('\r') || input.includes('\n');
  if (
    result.data.type === 'header' &&
    (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(result.data.name) ||
      result.data.name.length > 128 ||
      FORBIDDEN_PROMETHEUS_HEADERS.has(result.data.name.toLowerCase()) ||
      result.data.value.length > 64 * 1024 ||
      hasHeaderControl(result.data.value))
  )
    return null;
  if (
    (result.data.type === 'bearer' &&
      (result.data.token.length > 64 * 1024 || hasHeaderControl(result.data.token))) ||
    (result.data.type === 'basic' &&
      (result.data.username.length > 1024 || result.data.password.length > 64 * 1024)) ||
    (result.data.type === 'mtls' &&
      (result.data.cert.length > 128 * 1024 || result.data.key.length > 128 * 1024))
  )
    return null;
  return JSON.stringify(result.data);
}

export function publicPrometheusSettings(
  settings: unknown,
  eventCredential?: string | null,
): Record<string, unknown> {
  const parsed = parsePrometheusSettings(settings);
  if (!parsed) return {};
  const { caCert, ...visible } = parsed;
  return {
    ...visible,
    ...(caCert ? { caConfigured: true } : {}),
    eventCredentialConfigured: Boolean(alertmanagerEventToken(eventCredential)),
    smeeConfigured: Boolean(alertmanagerSmeeUrl(eventCredential)),
  };
}

export const ARGO_SEGMENT_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$|^\*$/;
export const ARGOCD_REQUEST_BYTES = 256 * 1024;
export const ARGOCD_TOKEN_BYTES = 64 * 1024;
export const ARGOCD_NAME_CHARS = 253;
export const ARGOCD_NAMESPACE_CHARS = 63;
export const ARGOCD_MAX_PROJECTS = 50;
export const ARGOCD_MAX_SCOPES = 50;

export interface ArgoCdCredentialBundle {
  version: 1;
  tokens: Array<{ project: string; token: string }>;
}

export async function boundedArgoCdJson(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ARGOCD_REQUEST_BYTES)
    throw new Error('request body is too large');
  if (!request.body) return JSON.parse(await request.text());
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > ARGOCD_REQUEST_BYTES) {
      await reader.cancel();
      throw new Error('request body is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body));
}

export function parseArgoCdSettings(input: unknown): ArgoCdSettings | null {
  const raw = requestObject(input);
  if (!raw || typeof raw.baseUrl !== 'string' || argoCdUrlError(raw.baseUrl)) return null;
  const url = new URL(raw.baseUrl.trim());
  if (
    (raw.applicationsInAnyNamespace !== false && raw.applicationsInAnyNamespace !== true) ||
    !Array.isArray(raw.projects) ||
    raw.projects.length === 0 ||
    raw.projects.length > ARGOCD_MAX_PROJECTS
  )
    return null;
  const anyNamespace = raw.applicationsInAnyNamespace;
  const projects: ArgoCdProjectBinding[] = [];
  const seenProjects = new Set<string>();
  let scopeCount = 0;
  for (const value of raw.projects) {
    const binding = requestObject(value);
    if (
      !binding ||
      typeof binding.project !== 'string' ||
      !Array.isArray(binding.applications) ||
      binding.applications.length === 0
    )
      return null;
    const project = binding.project.trim();
    if (
      project === '*' ||
      project.length > ARGOCD_NAME_CHARS ||
      !ARGO_SEGMENT_RE.test(project) ||
      seenProjects.has(project)
    )
      return null;
    seenProjects.add(project);
    const applications: ArgoCdProjectApplicationScope[] = [];
    for (const applicationValue of binding.applications) {
      const scope = requestObject(applicationValue);
      if (!scope || typeof scope.name !== 'string') return null;
      const name = scope.name.trim();
      const namespace = typeof scope.namespace === 'string' ? scope.namespace.trim() : undefined;
      if (name.length > ARGOCD_NAME_CHARS || !ARGO_SEGMENT_RE.test(name)) return null;
      if (anyNamespace) {
        if (
          !namespace ||
          namespace.length > ARGOCD_NAMESPACE_CHARS ||
          !ARGO_SEGMENT_RE.test(namespace)
        )
          return null;
      } else if (scope.namespace !== undefined) {
        return null;
      }
      applications.push({ name, ...(namespace ? { namespace } : {}) });
      scopeCount += 1;
      if (scopeCount > ARGOCD_MAX_SCOPES) return null;
    }
    projects.push({ project, applications });
  }
  const labelSelector =
    typeof raw.labelSelector === 'string' ? raw.labelSelector.trim() : undefined;
  if (
    raw.labelSelector !== undefined &&
    (!labelSelector ||
      labelSelector.length > 256 ||
      Array.from(labelSelector).some((character) => character.charCodeAt(0) < 0x20))
  )
    return null;
  const caCert = typeof raw.caCert === 'string' ? raw.caCert.trim() : undefined;
  if (raw.caCert !== undefined && typeof raw.caCert !== 'string') return null;
  if (caCert && caCert.length > 128 * 1024) return null;
  if (raw.insecureSkipTLSVerify !== undefined && typeof raw.insecureSkipTLSVerify !== 'boolean')
    return null;
  const accessRole =
    typeof raw.accessRole === 'string' ? raw.accessRole.trim().toLowerCase() : undefined;
  if (
    raw.accessRole !== undefined &&
    (!accessRole ||
      accessRole === '*' ||
      accessRole.length > ARGOCD_NAMESPACE_CHARS ||
      !ARGO_SEGMENT_RE.test(accessRole))
  )
    return null;
  const path = url.pathname.replace(/\/+$/, '');
  return {
    baseUrl: `${url.origin}${path}`,
    ...(accessRole ? { accessRole } : {}),
    applicationsInAnyNamespace: anyNamespace,
    projects,
    ...(labelSelector ? { labelSelector } : {}),
    ...(url.protocol === 'https:' && caCert ? { caCert } : {}),
    ...(url.protocol === 'https:' && raw.insecureSkipTLSVerify === true
      ? { insecureSkipTLSVerify: true }
      : {}),
  };
}

export function publicArgoCdSettings(
  settings: ArgoCdSettings,
  credentials?: ArgoCdCredentialBundle | null,
): Record<string, unknown> {
  const { caCert, ...visible } = settings;
  const configured = new Set(credentials?.tokens.map((entry) => entry.project) ?? []);
  return {
    ...visible,
    projects: settings.projects.map((binding) => ({
      ...binding,
      credentialConfigured: configured.has(binding.project),
    })),
    ...(caCert ? { caConfigured: true } : {}),
  };
}

export function publicKubernetesSettings(settings: unknown): Record<string, unknown> {
  const raw = requestObject(settings) ?? {};
  const { caCert, ...visible } = raw;
  return {
    ...visible,
    ...(typeof caCert === 'string' && caCert.trim() ? { caConfigured: true } : {}),
  };
}

export function parseArgoCdCredentialBundle(value: string | null): ArgoCdCredentialBundle | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const raw = requestObject(parsed);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.tokens)) return null;
  const tokens: ArgoCdCredentialBundle['tokens'] = [];
  const seen = new Set<string>();
  for (const tokenValue of raw.tokens) {
    const entry = requestObject(tokenValue);
    if (!entry || typeof entry.project !== 'string' || typeof entry.token !== 'string') return null;
    const project = entry.project.trim();
    const token = entry.token.trim();
    if (
      project === '*' ||
      !ARGO_SEGMENT_RE.test(project) ||
      seen.has(project) ||
      !token ||
      new TextEncoder().encode(token).byteLength > ARGOCD_TOKEN_BYTES
    )
      return null;
    seen.add(project);
    tokens.push({ project, token });
  }
  return tokens.length > 0 ? { version: 1, tokens } : null;
}

export function parseArgoCdCredentialInput(
  input: unknown,
): ArgoCdCredentialBundle['tokens'] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0) return [];
  return parseArgoCdCredentialBundle(JSON.stringify({ version: 1, tokens: input }))?.tokens ?? null;
}
