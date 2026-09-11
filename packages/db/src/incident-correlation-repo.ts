import type {
  IncidentCorrelationFeedback,
  IncidentCorrelationFeedbackDecision,
  IncidentCorrelationMethod,
} from '@sre/contracts';
import {
  EPISODE_GROUPING_WINDOW_MAX_SEC,
  EPISODE_GROUPING_WINDOW_MIN_SEC,
  INCIDENT_MAX_AGE_MAX_SEC,
  INCIDENT_MAX_AGE_MIN_SEC,
} from '@sre/contracts';
import { and, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { lockIncidentWorkTx } from './incident-relation-repo/core';
import type { Tx } from './rls';
import { ACTIVE_STATUSES, incidentRelations, incidentSignals, incidents } from './schema';

export interface IncidentEpisodeRouteInput {
  dataSourceId: string;
  subjectKey: string;
  observedAt: Date;
  groupingWindowMs: number;
  maxIncidentAgeMs: number;
  allowGrouping: boolean;
}

export interface IncidentCorrelationDecision {
  method: IncidentCorrelationMethod;
  rationale: string;
  features: string[];
  confidence: number;
  windowStartedAt: Date;
  windowExpiresAt: Date;
  maxIncidentAgeAt: Date;
  appliedFeedback: IncidentCorrelationFeedbackDecision | null;
}

export interface IncidentEpisodeRouteDecision extends IncidentCorrelationDecision {
  incident: { id: string; fingerprint: string } | null;
}

interface CorrelationCandidateRow extends Record<string, unknown> {
  activeCount: number;
  anyInsideMaximumAge: boolean;
  id: string | null;
  fingerprint: string | null;
  createdAt: Date | null;
  maxIncidentAgeAt: Date | null;
  windowExpiresAt: Date | null;
}

function assertPolicy(input: IncidentEpisodeRouteInput): void {
  if (!Number.isFinite(input.observedAt.getTime()))
    throw new Error('episode observation time must be valid');
  if (
    !Number.isSafeInteger(input.groupingWindowMs) ||
    input.groupingWindowMs < EPISODE_GROUPING_WINDOW_MIN_SEC * 1_000 ||
    input.groupingWindowMs > EPISODE_GROUPING_WINDOW_MAX_SEC * 1_000
  )
    throw new Error('episode grouping window is outside the supported bounds');
  if (
    !Number.isSafeInteger(input.maxIncidentAgeMs) ||
    input.maxIncidentAgeMs < INCIDENT_MAX_AGE_MIN_SEC * 1_000 ||
    input.maxIncidentAgeMs > INCIDENT_MAX_AGE_MAX_SEC * 1_000
  )
    throw new Error('incident maximum age is outside the supported bounds');
  if (input.maxIncidentAgeMs < input.groupingWindowMs)
    throw new Error('incident maximum age cannot be shorter than the grouping window');
}

function newIncidentDecision(
  input: IncidentEpisodeRouteInput,
  rationale: string,
  features: string[],
  appliedFeedback: IncidentCorrelationFeedbackDecision | null = null,
): IncidentEpisodeRouteDecision {
  return {
    incident: null,
    method: 'new_incident',
    rationale,
    features,
    confidence: 100,
    windowStartedAt: input.observedAt,
    windowExpiresAt: new Date(input.observedAt.getTime() + input.groupingWindowMs),
    maxIncidentAgeAt: new Date(input.observedAt.getTime() + input.maxIncidentAgeMs),
    appliedFeedback,
  };
}

/**
 * Reads the newest attributed correction for an exact connector and subject scope.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant that owns the correction record.
 * @param scopeKey - Provider-neutral connector and subject identity.
 */
async function latestCorrelationFeedbackTx(
  tx: Tx,
  tenantId: string,
  scopeKey: string,
): Promise<IncidentCorrelationFeedbackDecision | null> {
  const rows = await tx
    .select({ feedback: incidentRelations.correlationFeedback })
    .from(incidentRelations)
    .where(
      and(
        eq(incidentRelations.tenantId, tenantId),
        eq(incidentRelations.decidedBy, 'human'),
        isNotNull(incidentRelations.decidedByUserId),
        isNull(incidentRelations.supersededAt),
        sql`${incidentRelations.correlationFeedback} @> ${JSON.stringify({ sharedScopeKeys: [scopeKey] })}::jsonb`,
      ),
    )
    .orderBy(desc(incidentRelations.createdAt), desc(incidentRelations.id))
    .limit(1);
  return rows[0]?.feedback?.decision ?? null;
}

/**
 * Encodes a connector instance and stable subject without delimiter ambiguity.
 *
 * @param dataSourceId - Connector instance that owns the subject identity.
 * @param subjectKey - Stable provider-neutral monitor or rule identity.
 */
export function incidentCorrelationScopeKey(dataSourceId: string, subjectKey: string): string {
  if (!dataSourceId.trim() || !subjectKey.trim())
    throw new Error('correlation scope requires a data source and subject key');
  return JSON.stringify([dataSourceId, subjectKey]);
}

/**
 * Selects an active incident only while explicit identity, time bounds, and human feedback allow it.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param tenantId - Tenant that owns the connector and incidents.
 * @param input - Stable subject identity, observation time, and grouping policy.
 */
export async function decideIncidentEpisodeRouteTx(
  tx: Tx,
  tenantId: string,
  input: IncidentEpisodeRouteInput,
): Promise<IncidentEpisodeRouteDecision> {
  assertPolicy(input);
  const scopeKey = incidentCorrelationScopeKey(input.dataSourceId, input.subjectKey);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${scopeKey}:episode-route`}, 0))`,
  );

  if (!input.allowGrouping)
    return newIncidentDecision(
      input,
      'Provider-native firing episodes are investigated independently; time adjacency is only cohort context.',
      ['provider_episode_identity', 'independent_provider_episode'],
    );

  const activeStatuses = sql.join(
    ACTIVE_STATUSES.map((status) => sql`${status}`),
    sql`, `,
  );
  const observedAt = input.observedAt.toISOString();
  const query = await tx.execute<CorrelationCandidateRow>(sql`
    with candidates as (
      select incidents.id,
             incidents.fingerprint,
             incidents.created_at as "createdAt",
             coalesce(
               incidents.correlation_max_age_at,
               incidents.created_at + make_interval(secs => ${input.maxIncidentAgeMs / 1_000})
             ) as "maxIncidentAgeAt",
             latest."windowExpiresAt"
      from incidents
      join lateral (
        select coalesce(
                 history.correlation_window_expires_at,
                 history.first_seen_at + make_interval(secs => ${input.groupingWindowMs / 1_000})
               ) as "windowExpiresAt"
        from incident_signals history
        where history.tenant_id = incidents.tenant_id
          and history.incident_id = incidents.id
          and history.data_source_id = ${input.dataSourceId}
          and history.monitor_key = ${input.subjectKey}
        order by history.first_seen_at desc, history.id desc
        limit 1
      ) latest on true
      where incidents.tenant_id = ${tenantId}
        and incidents.status in (${activeStatuses})
        and incidents.archived_at is null
        and exists (
          select 1
          from incident_signals active
          where active.tenant_id = incidents.tenant_id
            and active.incident_id = incidents.id
            and active.data_source_id = ${input.dataSourceId}
            and active.monitor_key = ${input.subjectKey}
            and active.state = 'firing'
        )
    ), eligible as (
      select *
      from candidates
      where ${observedAt}::timestamptz <= "maxIncidentAgeAt"
        and ${observedAt}::timestamptz <= "windowExpiresAt"
      order by "createdAt" desc, id desc
      limit 2
    ), summary as (
      select count(*)::int as "activeCount",
             coalesce(bool_or(${observedAt}::timestamptz <= "maxIncidentAgeAt"), false)
               as "anyInsideMaximumAge"
      from candidates
    )
    select summary."activeCount", summary."anyInsideMaximumAge",
           eligible.id, eligible.fingerprint, eligible."createdAt",
           eligible."maxIncidentAgeAt", eligible."windowExpiresAt"
    from summary
    left join eligible on true
  `);
  const summary = query[0]!;
  const eligible = [...query].flatMap((row) =>
    row.id && row.fingerprint && row.createdAt && row.maxIncidentAgeAt && row.windowExpiresAt
      ? [
          {
            id: row.id,
            fingerprint: row.fingerprint,
            createdAt: row.createdAt,
            maxIncidentAgeAt: row.maxIncidentAgeAt,
            windowExpiresAt: row.windowExpiresAt,
          },
        ]
      : [],
  );
  if (summary.activeCount === 0)
    return newIncidentDecision(
      input,
      'No active incident owns this stable subject, so the firing starts a new investigation.',
      ['provider_episode_identity', 'stable_subject_identity', 'no_active_incident'],
    );
  if (eligible.length === 0) {
    return newIncidentDecision(
      input,
      summary.anyInsideMaximumAge
        ? 'The rolling grouping window expired before this firing arrived, so it starts a new episode.'
        : 'Every active matching incident reached its maximum correlation age, so this firing starts a new episode.',
      [
        'provider_episode_identity',
        'stable_subject_identity',
        'active_incident',
        summary.anyInsideMaximumAge ? 'rolling_window_expired' : 'incident_age_limit_reached',
      ],
    );
  }
  if (eligible.length > 1)
    return newIncidentDecision(
      input,
      'More than one active incident remains inside the correlation bounds, so the platform refused an ambiguous automatic grouping decision.',
      ['provider_episode_identity', 'stable_subject_identity', 'ambiguous_eligible_incidents'],
    );

  await lockIncidentWorkTx(tx, tenantId, [eligible[0]!.id]);
  const lockedRows = await tx
    .select({
      id: incidents.id,
      fingerprint: incidents.fingerprint,
      createdAt: incidents.createdAt,
      maxIncidentAgeAt: incidents.correlationMaxAgeAt,
    })
    .from(incidents)
    .where(and(eq(incidents.id, eligible[0]!.id), inArray(incidents.status, ACTIVE_STATUSES)))
    .limit(1)
    .for('update');
  const candidate = lockedRows[0];
  if (!candidate)
    return newIncidentDecision(
      input,
      'The candidate incident left the active lifecycle before routing completed.',
      ['provider_episode_identity', 'stable_subject_identity', 'candidate_no_longer_active'],
    );
  const appliedFeedback = await latestCorrelationFeedbackTx(tx, tenantId, scopeKey);
  if (appliedFeedback === 'separate')
    return newIncidentDecision(
      input,
      'The latest attributed responder correction says episodes in this scope require separate investigations.',
      [
        'provider_episode_identity',
        'stable_subject_identity',
        'active_incident',
        'human_separate_feedback',
      ],
      'separate',
    );

  const state = await tx.execute<{ windowExpiresAt: Date | null; hasFiring: boolean }>(sql`
    select (
             select coalesce(
                      history.correlation_window_expires_at,
                      history.first_seen_at + make_interval(secs => ${input.groupingWindowMs / 1_000})
                    )
             from incident_signals history
             where history.tenant_id = ${tenantId}
               and history.incident_id = ${candidate.id}
               and history.data_source_id = ${input.dataSourceId}
               and history.monitor_key = ${input.subjectKey}
             order by history.first_seen_at desc, history.id desc
             limit 1
           ) as "windowExpiresAt",
           exists (
             select 1
             from incident_signals active
             where active.tenant_id = ${tenantId}
               and active.incident_id = ${candidate.id}
               and active.data_source_id = ${input.dataSourceId}
               and active.monitor_key = ${input.subjectKey}
               and active.state = 'firing'
           ) as "hasFiring"
  `);
  if (!state[0]?.hasFiring || !state[0].windowExpiresAt)
    return newIncidentDecision(
      input,
      'The candidate no longer has an active signal for this stable subject.',
      ['provider_episode_identity', 'stable_subject_identity', 'active_signal_missing'],
    );

  const previousWindowExpiresAt = state[0].windowExpiresAt;
  const candidateMaxAgeAt =
    candidate.maxIncidentAgeAt ?? new Date(candidate.createdAt.getTime() + input.maxIncidentAgeMs);
  if (input.observedAt > candidateMaxAgeAt)
    return newIncidentDecision(
      input,
      'The active incident reached its maximum correlation age, so this firing starts a new episode.',
      [
        'provider_episode_identity',
        'stable_subject_identity',
        'active_incident',
        'incident_age_limit_reached',
      ],
      appliedFeedback,
    );
  if (input.observedAt > previousWindowExpiresAt)
    return newIncidentDecision(
      input,
      'The rolling grouping window expired before this firing arrived, so it starts a new episode.',
      [
        'provider_episode_identity',
        'stable_subject_identity',
        'active_incident',
        'rolling_window_expired',
      ],
      appliedFeedback,
    );

  return {
    incident: { id: candidate.id, fingerprint: candidate.fingerprint },
    method: 'stable_subject_window',
    rationale:
      'The same stable subject fired while its incident remained active and inside both correlation time bounds.',
    features: [
      'provider_episode_identity',
      'stable_subject_identity',
      'active_incident',
      'inside_rolling_window',
      'inside_incident_age_limit',
      ...(appliedFeedback === 'group' ? ['human_group_feedback'] : []),
    ],
    confidence: 100,
    windowStartedAt: input.observedAt,
    windowExpiresAt: new Date(input.observedAt.getTime() + input.groupingWindowMs),
    maxIncidentAgeAt: candidateMaxAgeAt,
    appliedFeedback,
  };
}

/**
 * Attaches the exact correlation decision to the episode signal it routed.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param signalId - Durable provider episode signal.
 * @param decision - Deterministic routing result and its safety bounds.
 */
export async function recordSignalCorrelationDecisionTx(
  tx: Tx,
  signalId: string,
  decision: IncidentCorrelationDecision,
): Promise<void> {
  const rows = await tx
    .update(incidentSignals)
    .set({
      correlationMethod: decision.method,
      correlationRationale: decision.rationale,
      correlationFeatures: decision.features,
      correlationConfidence: decision.confidence,
      correlationWindowStartedAt: decision.windowStartedAt,
      correlationWindowExpiresAt: decision.windowExpiresAt,
      correlationMaxAgeAt: decision.maxIncidentAgeAt,
    })
    .where(eq(incidentSignals.id, signalId))
    .returning({ incidentId: incidentSignals.incidentId });
  if (!rows[0]) throw new Error('correlation decision signal not found');
  await tx
    .update(incidents)
    .set({ correlationMaxAgeAt: decision.maxIncidentAgeAt })
    .where(and(eq(incidents.id, rows[0].incidentId), isNull(incidents.correlationMaxAgeAt)));
}

async function incidentScopeKeysTx(tx: Tx, incidentId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({
      dataSourceId: incidentSignals.dataSourceId,
      subjectKey: incidentSignals.monitorKey,
    })
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.incidentId, incidentId),
        isNotNull(incidentSignals.dataSourceId),
        isNotNull(incidentSignals.monitorKey),
      ),
    );
  return rows.map((row) => incidentCorrelationScopeKey(row.dataSourceId!, row.subjectKey!)).sort();
}

/**
 * Captures relation correction scopes so later routing can use attributed feedback.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param sourceIncidentId - Incident whose evidence may move.
 * @param targetIncidentId - Incident that the correction compares with the source.
 * @param decision - Whether future matching scopes should group or remain separate.
 */
export async function buildIncidentCorrelationFeedbackTx(
  tx: Tx,
  sourceIncidentId: string,
  targetIncidentId: string,
  decision: IncidentCorrelationFeedbackDecision,
): Promise<IncidentCorrelationFeedback> {
  const [sourceScopeKeys, targetScopeKeys] = await Promise.all([
    incidentScopeKeysTx(tx, sourceIncidentId),
    incidentScopeKeysTx(tx, targetIncidentId),
  ]);
  const target = new Set(targetScopeKeys);
  return {
    decision,
    sourceScopeKeys,
    targetScopeKeys,
    sharedScopeKeys: sourceScopeKeys.filter((key) => target.has(key)),
  };
}
