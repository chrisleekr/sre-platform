import { createHash } from 'node:crypto';
import type { NormalizedSnapshot } from './types';

export type ObservationState = 'firing' | 'unknown' | 'resolved';
export type ObservationTextScrubber = (value: string) => string;

export interface CanonicalSubjectObservation {
  state: ObservationState;
  summary: string;
  snapshot: Record<string, unknown>;
  contentHash: string;
  observedAt: Date;
}

export interface InfrastructureObservation extends CanonicalSubjectObservation {
  namespace?: string;
  hasError: boolean;
}

export interface ConnectorVerificationObservationInput {
  connectorType: string;
  connectorName: string;
  enabled: boolean;
  failureCategory: string | null;
  attemptedAt: Date | null;
  succeededAt: Date | null;
}

export interface TopologyServiceObservationInput {
  service: string;
  team: string | null;
  criticality: string | null;
  snapshots: NormalizedSnapshot[];
}

const MAX_STRING = 500;
const MAX_SUMMARY = 2_000;
const STALE_AFTER_MS = 60_000;
const identity: ObservationTextScrubber = (value) => value;

const text = (
  value: unknown,
  max = MAX_STRING,
  scrub: ObservationTextScrubber = identity,
): string | undefined =>
  typeof value === 'string' && value.trim()
    ? Array.from(scrub(value), (character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f ? ' ' : character;
      })
        .join('')
        .trim()
        .slice(0, max)
    : undefined;

const strings = (
  value: unknown,
  maxItems: number,
  maxLength: number,
  scrub: ObservationTextScrubber,
): string[] =>
  Array.isArray(value)
    ? [
        ...new Set(
          value.flatMap((item) =>
            text(item, maxLength, scrub) ? [text(item, maxLength, scrub)!] : [],
          ),
        ),
      ]
        .sort()
        .slice(0, maxItems)
    : [];

const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(1_000_000_000, Math.max(0, Math.trunc(value)))
    : 0;

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const material = (
  state: ObservationState,
  summary: string,
  snapshot: Record<string, unknown>,
  observedAt: Date,
): CanonicalSubjectObservation => ({
  state,
  summary,
  snapshot,
  contentHash: hash({ state, summary, snapshot }),
  observedAt,
});

/**
 * Normalizes one runtime snapshot into bounded lifecycle evidence.
 *
 * @param source - Provider snapshot to normalize.
 * @param now - Fallback observation time and staleness reference.
 * @param scrub - Tenant-safe text scrubber applied before persistence.
 */
export function normalizeInfrastructureObservation(
  source: NormalizedSnapshot,
  now: Date,
  scrub: ObservationTextScrubber = identity,
): InfrastructureObservation {
  const sourceObservedAt = new Date(source.observedAt);
  const observedAt = Number.isFinite(sourceObservedAt.getTime()) ? sourceObservedAt : now;
  const stale =
    !Number.isFinite(sourceObservedAt.getTime()) ||
    now.getTime() - sourceObservedAt.getTime() > STALE_AFTER_MS;
  const kind = text(source.metadata.kind, 30, scrub);
  const namespace = text(source.metadata.namespace, 200, scrub);
  const phase = text(source.metadata.phase, 60, scrub);
  const containers = Array.isArray(source.metadata.containers)
    ? source.metadata.containers
        .flatMap((raw) => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
          const item = raw as Record<string, unknown>;
          return [
            {
              name: text(item.name, 200, scrub),
              ready: item.ready === true,
              restartCount: count(item.restartCount),
              terminatedReason: text(item.terminatedReason, 100, scrub),
              waitingReason: text(item.waitingReason, 100, scrub),
              lastTerminatedReason: text(item.lastTerminatedReason, 100, scrub),
              lastTerminatedAt: text(item.lastTerminatedAt, 100, scrub),
            },
          ];
        })
        .sort((left, right) =>
          (left.name ?? '') < (right.name ?? '')
            ? -1
            : (left.name ?? '') > (right.name ?? '')
              ? 1
              : 0,
        )
        .slice(0, 10)
    : [];
  const pressures = strings(source.metadata.pressures, 20, 100, scrub);
  const ready = source.metrics.ready;
  const restarts = count(source.metrics.restartCount);
  const oomKilled = count(source.metrics.oomKilled);
  const pressureCount = count(source.metrics.pressures ?? pressures.length);
  const error = text(source.metadata.error, 500, scrub);
  const attention =
    !!error ||
    stale ||
    oomKilled > 0 ||
    (kind === 'pod' && phase !== 'Succeeded' && phase !== 'Running') ||
    (kind === 'pod' && phase !== 'Succeeded' && ready !== undefined && ready !== 1) ||
    containers.some((container) => !!container.waitingReason) ||
    (kind === 'node' && (ready !== 1 || pressureCount > 0)) ||
    (!kind && (ready === 0 || oomKilled > 0));
  const state: ObservationState = stale ? 'unknown' : attention ? 'firing' : 'resolved';
  const reasons = [
    ...(error ? [error] : []),
    ...(stale ? ['Telemetry is stale'] : []),
    ...(oomKilled > 0 ? [`${oomKilled} OOM-killed container${oomKilled === 1 ? '' : 's'}`] : []),
    ...(ready === 0 ? ['Not ready'] : []),
    ...(restarts > 0 ? [`${restarts} restart${restarts === 1 ? '' : 's'}`] : []),
    ...containers.flatMap((container) =>
      [container.waitingReason, container.terminatedReason].filter(
        (value): value is string => !!value,
      ),
    ),
    ...pressures,
  ];
  const snapshot = {
    kind,
    namespace,
    phase,
    ready: ready === 1,
    restartCount: restarts,
    oomKilled,
    pressures,
    containers,
  };
  const summary =
    state === 'resolved'
      ? 'Resource is healthy'
      : (text([...new Set(reasons)].slice(0, 40).join(' · '), MAX_SUMMARY, scrub) ??
        'Resource needs attention');
  return {
    ...material(state, summary, snapshot, observedAt),
    namespace,
    hasError: !!error,
  };
}

/**
 * Normalizes connector verification state into bounded lifecycle evidence.
 *
 * @param source - Verification result and connector identity.
 * @param now - Fallback time when the connector has not reported one.
 * @param scrub - Tenant-safe text scrubber applied before persistence.
 */
export function normalizeConnectorVerificationObservation(
  source: ConnectorVerificationObservationInput,
  now: Date,
  scrub: ObservationTextScrubber = identity,
): CanonicalSubjectObservation {
  const connectorType = text(source.connectorType, 100, scrub) ?? 'connector';
  const connectorName = text(source.connectorName, 200, scrub) ?? connectorType;
  const failureCategory = text(source.failureCategory, 100, scrub) ?? null;
  const recovered =
    !!source.attemptedAt && !!source.succeededAt && source.succeededAt >= source.attemptedAt;
  const state: ObservationState = !source.attemptedAt
    ? 'unknown'
    : recovered
      ? 'resolved'
      : 'firing';
  const summary =
    state === 'unknown'
      ? 'Connector verification has not run'
      : state === 'resolved'
        ? 'Connector verification succeeded'
        : `Verification failed${failureCategory ? `: ${failureCategory}` : ''}`;
  const snapshot = {
    connectorType,
    connectorName,
    enabled: source.enabled,
    failureCategory,
    attemptedAt: source.attemptedAt?.toISOString() ?? null,
    succeededAt: source.succeededAt?.toISOString() ?? null,
  };
  return material(
    state,
    text(summary, MAX_SUMMARY, scrub) ?? 'Connector verification state changed',
    snapshot,
    state === 'resolved'
      ? (source.succeededAt ?? source.attemptedAt ?? now)
      : state === 'firing'
        ? (source.attemptedAt ?? now)
        : now,
  );
}

/**
 * Aggregates service runtime snapshots into one bounded topology observation.
 *
 * @param source - Service identity and runtime snapshots to aggregate.
 * @param now - Fallback observation time and staleness reference.
 * @param scrub - Tenant-safe text scrubber applied before persistence.
 */
export function normalizeTopologyServiceObservation(
  source: TopologyServiceObservationInput,
  now: Date,
  scrub: ObservationTextScrubber = identity,
): CanonicalSubjectObservation {
  const service = text(source.service, 200, scrub) ?? 'service';
  const observations = source.snapshots.map((snapshot) =>
    normalizeInfrastructureObservation(snapshot, now, scrub),
  );
  const unresolved = observations.filter((observation) => observation.state !== 'resolved');
  const state: ObservationState =
    observations.length === 0
      ? 'unknown'
      : unresolved.some((observation) => observation.state === 'firing')
        ? 'firing'
        : unresolved.length > 0
          ? 'unknown'
          : 'resolved';
  const summary =
    observations.length === 0
      ? 'Runtime telemetry is unavailable'
      : state === 'resolved'
        ? `${observations.length}/${observations.length} runtime pods healthy`
        : state === 'unknown'
          ? `${unresolved.length}/${observations.length} runtime pods have stale or unknown telemetry`
          : `${unresolved.length}/${observations.length} runtime pods need attention`;
  const validObservedAt = source.snapshots
    .map((snapshot) => new Date(snapshot.observedAt))
    .filter((value) => Number.isFinite(value.getTime()));
  const snapshot = {
    service,
    team: text(source.team, 200, scrub) ?? null,
    criticality: text(source.criticality, 100, scrub) ?? null,
    pods: observations.length,
    unhealthyPods: unresolved.length,
    restarts: source.snapshots.reduce((sum, item) => sum + count(item.metrics.restartCount), 0),
    oomKilled: source.snapshots.reduce((sum, item) => sum + count(item.metrics.oomKilled), 0),
    summaries: unresolved
      .map((observation) => text(observation.summary, 200, scrub))
      .filter((value): value is string => !!value)
      .sort()
      .slice(0, 20),
  };
  return material(
    state,
    text(summary, MAX_SUMMARY, scrub) ?? 'Runtime state changed',
    snapshot,
    validObservedAt.length > 0
      ? new Date(Math.max(...validObservedAt.map((value) => value.getTime())))
      : now,
  );
}
