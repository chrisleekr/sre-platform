import { redactInput, scrubSecrets } from '@sre/agent-tools';
import type { SignalObservation, StoredAlertmanagerObservation } from '@sre/db';
import { createHash, timingSafeEqual } from 'node:crypto';
import { semanticMaterialText } from '@sre/connectors';
import {
  EPISODE_GROUPING_WINDOW_DEFAULT_SEC,
  EPISODE_GROUPING_WINDOW_MAX_SEC,
  EPISODE_GROUPING_WINDOW_MIN_SEC,
  INCIDENT_MAX_AGE_DEFAULT_SEC,
  INCIDENT_MAX_AGE_MAX_SEC,
  INCIDENT_MAX_AGE_MIN_SEC,
  entityCandidateKey,
  type AffectedEntityCandidate,
  type EntityCapability,
} from '@sre/contracts';

export const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
export const MAX_ALERTS = 500;
export const DEFAULT_COHORT_WINDOW_MS = 120_000;
export const ROOT_POST_STALE_MS = 30_000;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface NormalizedAlert {
  status: 'firing' | 'resolved';
  fingerprint: string;
  monitorIdentity: string | null;
  startsAt: Date;
  endsAt: Date | null;
  alertName: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  generatorUrl: string | null;
}

export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const string = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export function parseWebhookPrometheusSettings(
  value: unknown,
): { eventTransport: 'direct' | 'smee' | 'none' } | null {
  const eventTransport = object(value).eventTransport ?? 'none';
  return eventTransport === 'direct' || eventTransport === 'smee' || eventTransport === 'none'
    ? { eventTransport }
    : null;
}

/**
 * Converts saved connector bounds into the millisecond policy used by transactional routing.
 *
 * @param settings - Validated or legacy Prometheus connector settings.
 */
export function episodeGroupingPolicy(settings: Record<string, unknown>): {
  groupingWindowMs: number;
  maxIncidentAgeMs: number;
} {
  const groupingWindowSec = Number(settings.episodeGroupingWindowSec);
  const maxIncidentAgeSec = Number(settings.maxIncidentAgeSec);
  const boundedGroupingWindowSec =
    Number.isSafeInteger(groupingWindowSec) &&
    groupingWindowSec >= EPISODE_GROUPING_WINDOW_MIN_SEC &&
    groupingWindowSec <= EPISODE_GROUPING_WINDOW_MAX_SEC
      ? groupingWindowSec
      : EPISODE_GROUPING_WINDOW_DEFAULT_SEC;
  const boundedMaxIncidentAgeSec =
    Number.isSafeInteger(maxIncidentAgeSec) &&
    maxIncidentAgeSec >= INCIDENT_MAX_AGE_MIN_SEC &&
    maxIncidentAgeSec <= INCIDENT_MAX_AGE_MAX_SEC &&
    maxIncidentAgeSec >= boundedGroupingWindowSec
      ? maxIncidentAgeSec
      : INCIDENT_MAX_AGE_DEFAULT_SEC;
  return {
    groupingWindowMs: boundedGroupingWindowSec * 1_000,
    maxIncidentAgeMs: boundedMaxIncidentAgeSec * 1_000,
  };
}

function scrubKnownSecret(value: string, secret: string): string {
  return secret ? value.split(secret).join('[REDACTED]') : value;
}

export function sanitizeProviderUrl(value: string, knownSecret: string): string {
  const scrubbed = scrubSecrets(scrubKnownSecret(value, knownSecret));
  try {
    const url = new URL(scrubbed);
    if (url.username) url.username = '[REDACTED]';
    if (url.password) url.password = '[REDACTED]';
    const queryEntries = Array.from(url.searchParams.entries());
    for (const [key, item] of queryEntries) {
      const sanitized = redactInput({ [key]: item }) as Record<string, string>;
      url.searchParams.set(key, sanitized[key]!);
    }
    return url.toString();
  } catch {
    return scrubbed;
  }
}

function stringMap(
  value: unknown,
  limits: { maxEntries: number; maxKeyChars: number; maxValueChars: number; maxTotalChars: number },
): Record<string, string> | null {
  const raw = object(value);
  const entries = Object.entries(raw);
  if (entries.length > limits.maxEntries) return null;
  const result: Record<string, string> = {};
  let totalChars = 0;
  for (const [key, item] of entries) {
    if (
      !key ||
      key.length > limits.maxKeyChars ||
      typeof item !== 'string' ||
      item.length > limits.maxValueChars
    )
      return null;
    totalChars += key.length + item.length;
    if (totalChars > limits.maxTotalChars) return null;
    result[key] = item;
  }
  return result;
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

export function normalizeAlert(value: unknown, knownSecret: string): NormalizedAlert | null {
  const raw = object(value);
  const labels = stringMap(raw.labels, {
    maxEntries: 100,
    maxKeyChars: 128,
    maxValueChars: 2_048,
    maxTotalChars: 32_768,
  });
  const annotations = stringMap(raw.annotations, {
    maxEntries: 100,
    maxKeyChars: 128,
    maxValueChars: 16_384,
    maxTotalChars: 65_536,
  });
  const fingerprint = string(raw.fingerprint);
  const startsAt = date(raw.startsAt);
  const status = raw.status === 'firing' || raw.status === 'resolved' ? raw.status : null;
  const withoutKnownSecrets = (values: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(values).map(([key, item]) => [key, scrubKnownSecret(item, knownSecret)]),
    );
  const sanitizedLabels = labels
    ? (redactInput(withoutKnownSecrets(labels)) as Record<string, string>)
    : null;
  const sanitizedAnnotations = annotations
    ? (redactInput(withoutKnownSecrets(annotations)) as Record<string, string>)
    : null;
  const alertName = sanitizedLabels?.alertname?.trim();
  const rawMonitorId = labels?.sre_monitor_id?.trim();
  const generatorUrl = string(raw.generatorURL);
  if (
    !sanitizedLabels ||
    !sanitizedAnnotations ||
    !fingerprint ||
    !/^[0-9a-f]{16}$/.test(fingerprint) ||
    !startsAt ||
    !status ||
    !alertName ||
    (generatorUrl?.length ?? 0) > 8_192
  )
    return null;
  return {
    status,
    fingerprint,
    monitorIdentity: rawMonitorId ? hash({ explicitMonitorId: rawMonitorId }) : null,
    startsAt,
    endsAt: status === 'resolved' ? date(raw.endsAt) : null,
    alertName,
    labels: sanitizedLabels,
    annotations: sanitizedAnnotations,
    generatorUrl: generatorUrl ? sanitizeProviderUrl(generatorUrl, knownSecret) : null,
  };
}

/**
 * Captures the sanitized provider observation that survives external-post and process retries.
 *
 * @param groupKey - Alertmanager group identity from the delivery envelope.
 * @param externalUrl - Sanitized Alertmanager source URL.
 * @param alert - Validated provider episode observation.
 */
export function storedAlertmanagerObservation(
  groupKey: string,
  externalUrl: string | null,
  alert: NormalizedAlert,
): StoredAlertmanagerObservation {
  return {
    status: alert.status,
    groupKey,
    alertName: alert.alertName,
    monitorIdentity: alert.monitorIdentity,
    labels: alert.labels,
    annotations: alert.annotations,
    endsAt: alert.endsAt?.toISOString() ?? null,
    generatorUrl: alert.generatorUrl,
    externalUrl,
  };
}

/**
 * Restores the durable provider observation used after a Slack-post or routing retry.
 *
 * @param input - Intake identity, immutable destination, and latest accepted observation.
 */
export function restoreStoredAlertmanagerEpisode(input: {
  providerFingerprint: string;
  startsAt: Date;
  materialHash: string;
  channel: string;
  observation: StoredAlertmanagerObservation;
}): {
  alert: NormalizedAlert;
  groupKey: string;
  materialHash: string;
  channel: string;
} {
  const endsAt = input.observation.endsAt ? new Date(input.observation.endsAt) : null;
  if (endsAt && !Number.isFinite(endsAt.getTime()))
    throw new Error('stored Alertmanager end time is invalid');
  return {
    alert: {
      status: input.observation.status,
      fingerprint: input.providerFingerprint,
      monitorIdentity: input.observation.monitorIdentity ?? null,
      startsAt: input.startsAt,
      endsAt,
      alertName: input.observation.alertName,
      labels: input.observation.labels,
      annotations: input.observation.annotations,
      generatorUrl: input.observation.generatorUrl,
    },
    groupKey: input.observation.groupKey,
    materialHash: input.materialHash,
    channel: input.channel,
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export const hash = (value: unknown): string =>
  createHash('sha256').update(stable(value)).digest('hex');

/** Stable opaque Alertmanager rule scope, falling back to exact label-set identity. */
export function alertmanagerMonitorKey(
  connectorId: string,
  alert: Pick<NormalizedAlert, 'alertName' | 'fingerprint' | 'labels'> &
    Partial<Pick<NormalizedAlert, 'monitorIdentity'>>,
): string {
  const monitorIdentity =
    alert.monitorIdentity ??
    (alert.labels.sre_monitor_id?.trim() && alert.labels.sre_monitor_id.trim() !== '[REDACTED]'
      ? hash({ explicitMonitorId: alert.labels.sre_monitor_id.trim() })
      : null);
  const scope = monitorIdentity
    ? { alertName: alert.alertName, monitorIdentity }
    : { providerFingerprint: alert.fingerprint };
  return `alertmanager:${connectorId}:${hash(scope)}`;
}

/** Investigation-relevant Alertmanager material, excluding volatile observation values and links. */
export function investigationMaterial(
  alert: Pick<NormalizedAlert, 'annotations' | 'labels'>,
): Record<string, unknown> {
  return {
    labels: alert.labels,
    annotations: Object.fromEntries(
      Object.entries(alert.annotations).map(([key, value]) => [key, semanticMaterialText(value)]),
    ),
  };
}

export function sameSecret(supplied: string, expected: string): boolean {
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function severity(labels: Record<string, string>): string {
  const value = labels.severity?.toLowerCase();
  if (value === 'critical' || value === 'page' || value === 'sev1' || value === 'p1') return 'sev1';
  if (value === 'warning' || value === 'warn' || value === 'sev2' || value === 'p2') return 'sev2';
  return 'sev3';
}

function firstNonblankLabel(
  labels: Record<string, string>,
  names: readonly string[],
): { value: string; label: string } | null {
  for (const label of names) {
    const value = labels[label]?.trim();
    if (value) return { value, label };
  }
  return null;
}

export function service(labels: Record<string, string>): string {
  return (
    firstNonblankLabel(labels, ['service', 'app', 'app.kubernetes.io/name'])?.value ??
    'unclassified'
  );
}

const requiredCapabilities = (kind: AffectedEntityCandidate['kind']): EntityCapability[] => {
  if (kind === 'service') return ['runtime', 'metrics', 'logs', 'source_code', 'deployments'];
  if (kind === 'repository') return ['source_code', 'deployments'];
  if (kind === 'deployment') return ['deployments'];
  if (kind === 'endpoint') return ['availability', 'metrics', 'logs'];
  if (kind === 'database') return ['metrics', 'logs'];
  return ['runtime', 'metrics', 'logs'];
};

/** Extracts typed affected-entity possibilities without promoting routing labels to services. */
export function alertmanagerAffectedEntities(
  alert: Pick<NormalizedAlert, 'labels'>,
  observedAt: Date,
  dataSourceId?: string,
): AffectedEntityCandidate[] {
  const labels = alert.labels;
  const serviceLabel = firstNonblankLabel(labels, ['service', 'app', 'app.kubernetes.io/name']);
  const workloadLabel = firstNonblankLabel(labels, ['workload', 'deployment', 'pod']);
  const namespaceLabel = firstNonblankLabel(labels, ['namespace']);
  const nodeLabel = firstNonblankLabel(labels, ['node']);
  const clusterLabel = firstNonblankLabel(labels, ['cluster']);
  const repositoryLabel = firstNonblankLabel(labels, ['repository', 'repo']);
  const databaseLabel = firstNonblankLabel(labels, ['database', 'db']);
  const hostLabel = firstNonblankLabel(labels, ['host', 'hostname']);
  const endpointLabel = firstNonblankLabel(labels, ['instance']);
  const scopeFor = (kind: AffectedEntityCandidate['kind']): Record<string, string> => {
    const includeCluster = kind !== 'repository';
    const includeNamespace =
      kind === 'service' || kind === 'workload' || kind === 'endpoint' || kind === 'database';
    return Object.fromEntries(
      [
        ['dataSourceId', dataSourceId],
        ...(includeCluster
          ? ([['cluster', clusterLabel?.value]] as Array<[string, string | undefined]>)
          : []),
        ...(includeNamespace
          ? ([['namespace', namespaceLabel?.value]] as Array<[string, string | undefined]>)
          : []),
      ].filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
  };
  const raw: Array<{
    kind: AffectedEntityCandidate['kind'];
    stableId: string | undefined;
    label: string;
    confidence: number;
  }> = [
    {
      kind: 'service',
      stableId: serviceLabel?.value,
      label: serviceLabel?.label ?? 'service',
      confidence: serviceLabel?.label === 'service' ? 95 : 90,
    },
    {
      kind: 'workload',
      stableId: workloadLabel?.value,
      label: workloadLabel?.label ?? 'workload',
      confidence: 85,
    },
    { kind: 'namespace', stableId: namespaceLabel?.value, label: 'namespace', confidence: 75 },
    { kind: 'node', stableId: nodeLabel?.value, label: 'node', confidence: 90 },
    { kind: 'cluster', stableId: clusterLabel?.value, label: 'cluster', confidence: 90 },
    {
      kind: 'repository',
      stableId: repositoryLabel?.value,
      label: repositoryLabel?.label ?? 'repository',
      confidence: 85,
    },
    {
      kind: 'database',
      stableId: databaseLabel?.value,
      label: databaseLabel?.label ?? 'database',
      confidence: 85,
    },
    {
      kind: 'host',
      stableId: hostLabel?.value,
      label: hostLabel?.label ?? 'host',
      confidence: 85,
    },
    { kind: 'endpoint', stableId: endpointLabel?.value, label: 'instance', confidence: 75 },
  ];
  const seen = new Set<string>();
  return raw.flatMap((candidate) => {
    if (!candidate.stableId) return [];
    const scope = scopeFor(candidate.kind);
    const key = entityCandidateKey(candidate.kind, candidate.stableId, scope);
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        key,
        kind: candidate.kind,
        stableId: candidate.stableId,
        displayName: candidate.stableId,
        scope,
        provenance: { kind: 'provider_label' as const, source: candidate.label },
        confidence: candidate.confidence,
        observedAt: observedAt.toISOString(),
        completeness: candidate.kind === 'service' ? ('complete' as const) : ('partial' as const),
        requiredCapabilities: requiredCapabilities(candidate.kind),
      },
    ];
  });
}

export function alertText(alert: NormalizedAlert): string {
  const clip = (value: string, maxChars: number): string =>
    value.length > maxChars ? `${value.slice(0, maxChars - 1)}…` : value;
  const alertName = clip(alert.alertName, 512);
  const summary = clip(
    alert.annotations.summary || alert.annotations.description || alertName,
    4_000,
  );
  const description = alert.annotations.description
    ? clip(alert.annotations.description, 8_000)
    : undefined;
  return [
    `[${alert.status.toUpperCase()}] ${alertName}`,
    summary,
    description && description !== summary ? description : null,
    `Severity: ${clip(alert.labels.severity || 'unspecified', 128)}`,
    `Service: ${clip(service(alert.labels), 512)}`,
    alert.generatorUrl ? `Source: ${clip(alert.generatorUrl, 2_048)}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function signalObservation(
  connectorId: string,
  groupKey: string,
  alert: NormalizedAlert,
  materialHash: string,
  observedAt: Date,
): Omit<SignalObservation, 'incidentId'> {
  const episodeKey = `alertmanager:${connectorId}:${alert.fingerprint}:${alert.startsAt.toISOString()}`;
  return {
    dataSourceId: connectorId,
    provider: 'alertmanager',
    providerFingerprint: alert.fingerprint,
    providerGroupKey: groupKey,
    monitorKey: alertmanagerMonitorKey(connectorId, alert),
    alertName: alert.alertName,
    startsAt: alert.startsAt,
    endsAt: alert.endsAt,
    labels: alert.labels,
    annotations: alert.annotations,
    generatorUrl: alert.generatorUrl ?? undefined,
    signalSource: {
      kind: 'monitor',
      provider: 'alertmanager',
      dataSourceId: connectorId,
      externalId: alertmanagerMonitorKey(connectorId, alert),
      displayName: alert.alertName,
      observedAt: observedAt.toISOString(),
    },
    affectedEntities: alertmanagerAffectedEntities(alert, observedAt, connectorId),
    materialHash,
    surface: 'alertmanager',
    channel: connectorId,
    externalMessageId: episodeKey,
    state: alert.status,
    summary: alertText(alert),
    contentHash: hash({ status: alert.status, materialHash, endsAt: alert.endsAt?.toISOString() }),
    eventKey: `${episodeKey}:${alert.status}:${materialHash}:${alert.endsAt?.toISOString() ?? ''}`,
    eventAt: observedAt,
  };
}
