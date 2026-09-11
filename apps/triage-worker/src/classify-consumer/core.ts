import {
  ThreadAlreadyBoundError,
  routeToIncident,
  type IncidentSignal,
  type RouteResult,
} from '@sre/alerts';
import type { InboundCandidate } from '@sre/connectors';
import {
  listActiveIncidents,
  listUnresolvedSignals,
  retrieveNearestActive,
  setIncidentEmbedding,
  type IncidentSummary,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { RetryableError } from '@sre/queue';
import { createHash } from 'node:crypto';
import { entityCandidateKey } from '@sre/contracts';
import { priorThreadMessage } from './attachments';
import type {
  AuthorizedResolutionCandidate,
  ClassifyHandlerDeps,
  ClassifyOutcome,
  OpenIncidentOptions,
  ResolutionCandidates,
  RouteFn,
} from './contracts';
import {
  ACTIVE_WINDOW_MS,
  CAP_N,
  CLASSIFY_FAIL_OPEN_ATTEMPTS,
  INBOUND_DEDUP_TTL_SEC,
  RETRIEVE_K,
} from './contracts';

export const serviceForChannel = (channel: string): string => `slack:${channel}`;

/**
 * Selects a concise incident title from normalized provider evidence.
 * @param text - Scrubbed inbound message text used when the adapter supplied no alert name.
 * @param observations - Scrubbed normalized observations carried by the inbound message.
 */
export function providerAlertTitle(
  text: string,
  observations: InboundCandidate['observations'] = [],
): string {
  for (const observation of observations ?? []) {
    const alertName = observation.alertName?.trim();
    if (alertName) return alertName.slice(0, 120);
  }
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.slice(0, 120) ?? 'Provider alert';
}

/**
 * Derives one incident-correlation identity from raw evidence or immutable provider message identity.
 * @param candidate - Slack observation carrying raw evidence or a promoted edit's stable identity.
 */
export function fingerprintFor(
  candidate: Pick<InboundCandidate, 'raw' | 'channel' | 'externalId' | 'producerId'>,
): string {
  const source =
    candidate.raw === null || candidate.raw === undefined
      ? {
          channel: candidate.channel,
          externalId: candidate.externalId,
          producerId: candidate.producerId ?? null,
        }
      : candidate.raw;
  let serialized: string;
  try {
    serialized = JSON.stringify(source) ?? String(source);
  } catch {
    serialized = String(source);
  }
  return `slack:${createHash('sha256').update(serialized).digest('hex')}`;
}

function inferredServiceCandidate(
  service: string,
  observedAt: Date,
): ReturnType<typeof entityCandidate> | null {
  if (service === 'unknown' || service === 'unclassified' || service.startsWith('slack:'))
    return null;
  return entityCandidate(service, observedAt);
}

function entityCandidate(service: string, observedAt: Date) {
  return {
    key: entityCandidateKey('service', service),
    kind: 'service' as const,
    stableId: service,
    displayName: service,
    scope: {},
    provenance: { kind: 'classifier_inference' as const, source: 'inbound_classifier' },
    confidence: 60,
    observedAt: observedAt.toISOString(),
    completeness: 'partial' as const,
    requiredCapabilities: [
      'runtime' as const,
      'metrics' as const,
      'logs' as const,
      'source_code' as const,
      'deployments' as const,
    ],
  };
}

export class ClassifyCore {
  readonly route: RouteFn;

  constructor(readonly deps: ClassifyHandlerDeps) {
    this.route =
      deps.route ??
      ((signal) =>
        routeToIncident(
          {
            appDb: deps.appDb,
            redis: deps.reservationRedis,
            queue: deps.queue,
            appendOpenerTx: signal.opener
              ? async (tx, tenantId, incidentId, opener, observed) => {
                  if (!deps.hub?.appendTxOnce)
                    throw new Error(
                      'classify incident opener path is not wired (hub.appendTxOnce)',
                    );
                  const opened = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
                    ...opener,
                    ...(observed
                      ? {
                          kind: 'signal' as const,
                          signalId: observed.id,
                          signalState: observed.state,
                          signalEventType: observed.eventType,
                        }
                      : {}),
                  });
                  const lifecycle = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
                    author: 'system',
                    kind: 'lifecycle',
                    content:
                      signal.purpose === 'health_check'
                        ? 'Health check started. No outage has been asserted.'
                        : 'Incident open: alert accepted for investigation.',
                    lifecycleFrom: null,
                    lifecycleTo: 'open',
                    lifecycleVersion: 0,
                    transitionKey: `incident-open:${incidentId}:0`,
                  });
                  const context = signal.context as { priorThread?: unknown } | null;
                  if (
                    opener.author === 'human' &&
                    typeof context?.priorThread === 'string' &&
                    context.priorThread.trim()
                  )
                    await deps.hub.appendTxOnce(
                      tx,
                      tenantId,
                      incidentId,
                      priorThreadMessage(context.priorThread, opener.originMessageId),
                    );
                  return {
                    incidentId: opened.message.incidentId,
                    afterCommit: async () => {
                      await deps.hub!.publishAppended(opened.message);
                      await deps.hub!.publishAppended(lifecycle.message);
                    },
                  };
                }
              : undefined,
          },
          signal,
        ));
  }

  /** Publishes a committed message without turning recoverable Valkey loss into classify replay. */
  async publishAppended(message: HubMessage): Promise<void> {
    try {
      await this.deps.hub?.publishAppended(message);
    } catch (error) {
      this.warnPostCommitFailure('hub', error, { incidentId: message.incidentId });
    }
  }

  /** Dispatches a durable job without turning recoverable Valkey loss into classify replay. */
  async publishJob(jobId: string): Promise<void> {
    try {
      await this.deps.queue.publishJob(jobId);
    } catch (error) {
      this.warnPostCommitFailure('queue', error, { jobId });
    }
  }

  /** Records a bounded post-commit failure while PostgreSQL reconciliation remains authoritative. */
  warnPostCommitFailure(
    target: 'hub' | 'queue' | 'breadcrumb',
    error: unknown,
    identity: { incidentId?: string; jobId?: string } = {},
  ): void {
    console.warn(
      JSON.stringify({
        level: 'warn',
        app: 'triage-worker',
        event: 'classify.post_commit_delivery_failed',
        target,
        ...identity,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      }),
    );
  }

  async emitOutcome(outcome: ClassifyOutcome): Promise<void> {
    await this.deps.onOutcome?.(outcome);
  }

  /**
   * Checks whether the adapter durably superseded this inbound receipt.
   * @param tenantId - Tenant that owns the classify job.
   * @param candidate - Candidate carrying the durable intake receipt identifier.
   */
  async isSuperseded(tenantId: string, candidate: InboundCandidate): Promise<boolean> {
    if (!candidate.intakeId || !this.deps.isIntakeSuperseded) return false;
    return this.deps.isIntakeSuperseded(
      tenantId,
      candidate.intakeId,
      new Date(candidate.eventAt),
      candidate.eventVersion,
    );
  }

  /**
   * Checks whether another durable classify job still owns this stable surface message.
   * @param tenantId - Tenant that owns the classify job.
   * @param candidate - Edit candidate whose own receipt must be excluded.
   */
  async hasPendingPredecessor(tenantId: string, candidate: InboundCandidate): Promise<boolean> {
    return (
      (await this.deps.hasPendingClassification?.(
        tenantId,
        {
          surface: 'slack',
          channel: candidate.channel,
          externalMessageId: candidate.externalId,
        },
        candidate.intakeId,
      )) ?? false
    );
  }

  /**
   * Fences incident-writing work against the adapter's durable stable-message decision.
   * @param tenantId - Tenant that owns the classify job.
   * @param candidate - Candidate carrying the durable receipt and provider event time.
   * @param fn - Incident or signal mutation protected by the database's late-write guard.
   */
  async withRoutingFence<T>(
    tenantId: string,
    candidate: InboundCandidate,
    fn: () => Promise<T>,
  ): Promise<{ status: 'executed'; value: T } | { status: 'superseded' }> {
    if (!candidate.intakeId || !this.deps.withIntakeRoutingFence)
      return { status: 'executed', value: await fn() };
    return this.deps.withIntakeRoutingFence(
      tenantId,
      candidate.intakeId,
      new Date(candidate.eventAt),
      candidate.eventVersion,
      { surface: 'slack', channel: candidate.channel, externalMessageId: candidate.externalId },
      fn,
    );
  }

  async routeOrRetry(signal: IncidentSignal, abortSignal?: AbortSignal): Promise<RouteResult> {
    try {
      return await this.route(signal);
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      if (error instanceof ThreadAlreadyBoundError) throw error;
      throw new RetryableError('classify route failed');
    }
  }

  async seedEmbedding(tenantId: string, incidentId: string, scrubbedText: string): Promise<void> {
    try {
      const [vector] = await this.deps.embedder.embed([scrubbedText]);
      if (vector) await setIncidentEmbedding(this.deps.appDb, tenantId, incidentId, vector);
    } catch {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'correlation.seed_embed_failed',
          tenantId,
          incidentId,
        }),
      );
    }
  }

  async buildCandidates(tenantId: string, scrubbedText: string): Promise<IncidentSummary[]> {
    const since = new Date(Date.now() - ACTIVE_WINDOW_MS);
    try {
      const active = await listActiveIncidents(this.deps.appDb, tenantId, { since });
      if (active.length <= CAP_N) return active;
      return await retrieveNearestActive(this.deps.appDb, this.deps.embedder, tenantId, {
        text: scrubbedText,
        k: RETRIEVE_K,
        since,
      });
    } catch {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'correlation.candidates_failed',
          tenantId,
        }),
      );
      return [];
    }
  }

  async buildResolutionCandidates(
    tenantId: string,
    candidate: InboundCandidate,
    attempts: number,
  ): Promise<ResolutionCandidates> {
    if (candidate.author !== 'bot' || !candidate.producerId)
      return { all: [], forModel: [], lookupFailed: false };
    const producerTag = `:producer:${candidate.producerId}`;
    let all: AuthorizedResolutionCandidate[];
    try {
      all = (await listUnresolvedSignals(this.deps.appDb, tenantId)).filter(
        (signal) =>
          signal.channel === candidate.channel && signal.lastEventKey.endsWith(producerTag),
      );
    } catch {
      console.warn(
        JSON.stringify({
          level: 'warn',
          app: 'triage-worker',
          event: 'resolution.candidates_failed',
          tenantId,
        }),
      );
      if (candidate.signalState === 'resolved' && attempts < CLASSIFY_FAIL_OPEN_ATTEMPTS)
        throw new RetryableError('resolution candidates unavailable');
      return { all: [], forModel: [], lookupFailed: true };
    }
    const exactEdit = candidate.isEdit
      ? all.find((signal) => signal.externalMessageId === candidate.externalId)
      : undefined;
    const recent = all.slice(-Math.max(1, CAP_N));
    return {
      all,
      forModel: candidate.isEdit ? (exactEdit ? [exactEdit] : []) : recent,
      lookupFailed: false,
    };
  }

  async openNewIncident(
    tenantId: string,
    fingerprint: string,
    thread: { channel: string; threadId: string },
    fields: {
      service: string;
      severity: string;
      title: string;
      purpose?: 'incident' | 'health_check';
    },
    context: unknown,
    scrubbedSeed: string,
    opener: NonNullable<IncidentSignal['opener']>,
    onThreadTaken: (ownerIncidentId: string) => Promise<void>,
    options: OpenIncidentOptions = {},
  ): Promise<void> {
    const inferredService = inferredServiceCandidate(fields.service, new Date());
    const enrichSignal = (signal: NonNullable<OpenIncidentOptions['signal']>) => ({
      ...signal,
      affectedEntities:
        signal.affectedEntities ??
        (inferredService ? [{ ...inferredService, observedAt: signal.eventAt.toISOString() }] : []),
    });
    const enrichedSignals = options.signals?.map(enrichSignal);
    const enrichedSignal = options.signal ? enrichSignal(options.signal) : undefined;
    const followupJobIds: string[] = [];
    let created: RouteResult;
    try {
      created = await this.routeOrRetry({
        tenantId,
        source: 'slack',
        fingerprint,
        service: fields.service,
        severity: fields.severity,
        purpose: fields.purpose,
        title: fields.title,
        context,
        investigationTrigger:
          options.investigationTrigger ??
          (opener.author === 'human'
            ? { reason: 'manual_investigation', automatic: false, monitorKey: null }
            : {
                reason: 'new_episode',
                automatic: true,
                monitorKey:
                  options.signals?.find((signal) => signal.monitorKey)?.monitorKey ??
                  options.signal?.monitorKey ??
                  null,
              }),
        opener,
        origin: { surface: 'slack', ...thread },
        dedupTtlSec: INBOUND_DEDUP_TTL_SEC,
        dedupKey: options.dedupKey,
        signal: enrichedSignal,
        signals: enrichedSignals,
        ...(options.onRoutedTx
          ? {
              onRoutedTx: async (tx, routed) => {
                followupJobIds.push(...(await options.onRoutedTx!(tx, routed)));
              },
            }
          : {}),
      });
    } catch (error) {
      if (!(error instanceof ThreadAlreadyBoundError)) throw error;
      await onThreadTaken(error.incidentId);
      return;
    }
    if (!created.incidentId) return;
    for (const jobId of followupJobIds) await this.publishJob(jobId);
    if (created.reused) {
      await onThreadTaken(created.incidentId);
      return;
    }
    await this.seedEmbedding(tenantId, created.incidentId, scrubbedSeed);
  }

  messageKey(channel: string, messageId: string): string {
    return `slack:${channel}:${messageId}`;
  }

  openerFor(candidate: InboundCandidate, content: string): NonNullable<IncidentSignal['opener']> {
    return {
      author: candidate.author === 'bot' ? 'system' : 'human',
      content,
      originSurface: 'slack',
      originMessageId: this.messageKey(candidate.channel, candidate.externalId),
    };
  }

  signalsFor(candidate: InboundCandidate) {
    const observations = candidate.observations?.length
      ? candidate.observations
      : [
          {
            externalMessageId: candidate.externalId,
            state: candidate.signalState,
            summary: candidate.text,
            contentHash: candidate.contentHash,
            eventKey: candidate.eventKey,
            eventAt: candidate.eventAt,
            eventVersion: candidate.eventVersion,
          },
        ];
    return observations.map((observation) => {
      const monitorKey =
        observation.monitorKey ??
        (observation.providerGroupKey
          ? [
              'slack',
              candidate.channel,
              observation.providerGroupKey,
              observation.alertName ?? '',
            ].join(':')
          : undefined);
      return {
        surface: 'slack',
        channel: candidate.channel,
        ...observation,
        ...(monitorKey ? { monitorKey } : {}),
        eventAt: new Date(observation.eventAt),
        signalSource: {
          kind: candidate.author === 'human' ? ('human_report' as const) : ('connector' as const),
          provider: observation.provider ?? 'slack',
          dataSourceId: null,
          externalId: candidate.producerId ?? `slack:${candidate.channel}:${candidate.author}`,
          displayName: candidate.author === 'human' ? 'Slack responder' : 'Slack inbound connector',
          observedAt: new Date(observation.eventAt).toISOString(),
        },
      };
    });
  }

  signalFor(candidate: InboundCandidate) {
    return this.signalsFor(candidate)[0]!;
  }
}
