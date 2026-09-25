import type { AlertLifecycleSubjectMatch, IDataSourceConnector } from '@sre/connectors';
import {
  ACTIVE_STATUSES,
  bindSignalToEpisodeTx,
  connectorConfigs,
  incidentSignals,
  incidents,
  lockResponseGroupWorkTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import { createHash } from 'node:crypto';
import { and, eq, gte, isNull, like, lte, ne, type SQL } from 'drizzle-orm';
import { scrubSecrets } from './redact';
import { SubjectMissCache } from './subject-miss-cache';

type Signal = typeof incidentSignals.$inferSelect;
type AppendedMessage = Awaited<ReturnType<ConversationHub['appendTxOnce']>>['message'];
type SubjectBindOutcome =
  { signal: Signal; message: AppendedMessage } | { reason: string } | { settled: true };

const STATUSCAKE_UPTIME_SUBJECT = 'statuscake:uptime:';

/** Remembered subject-path answers, keyed per URL or per signal under one connector generation. */
export type SubjectMisses = Pick<SubjectMissCache<{ reason: string }>, 'get' | 'set'>;
// A persistent no-match then costs one inventory listing per ten minutes, not one per pass.
const subjectMisses = new SubjectMissCache<{ reason: string }>({
  ttlMs: 10 * 60_000,
  maxEntries: 500,
});
// Provider answers about one notice that the next pass would only repeat. A read failure or a
// generation race is retried. A duplicate of a bound outage still clears through the owner's
// recovery, which never consults this cache.
const SIGNAL_MISS_REASONS = new Set([
  'ambiguous_episode',
  'episode_not_retained',
  'provider_episode_already_bound',
]);

/** Stock StatusCake Slack notices name a URL and no test id, so they carry no binding of their own.
 * @param connector - Connector whose reconcile pass may select such notices.
 */
export function subjectSelectionEligibility(connector: IDataSourceConnector): SQL | undefined {
  if (connector.type !== 'statuscake' || !connector.alertLifecycle?.monitorForSubject)
    return undefined;
  return and(
    eq(incidentSignals.surface, 'slack'),
    eq(incidentSignals.provider, 'statuscake'),
    isNull(incidentSignals.dataSourceId),
    // A notice already cleared by its outage's provider episode has nothing left to verify.
    ne(incidentSignals.state, 'resolved'),
    like(incidentSignals.providerGroupKey, `${STATUSCAKE_UPTIME_SUBJECT}%`),
  );
}

/**
 * Binds an unbound notification signal to the one provider episode its subject names.
 *
 * @remarks The subject only selects which monitor to ask about. Authority comes from the exact
 * episode read: the provider must report one outage, with a start, covering the moment the platform
 * first saw the notification. Nothing is written to the connector's saved bindings, so this never
 * consumes the operator binding capacity. Later passes find the signal through its data source and
 * `monitor_id` label, as they do a native signal.
 * @param input - Tenant, fenced connector generation, hub, the signal row read this pass, a per-pass
 * memo so one inventory read serves every signal naming the same subject, and the miss cache.
 */
export async function bindSignalFromSubject(input: {
  db: Db;
  tenantId: string;
  connector: IDataSourceConnector;
  hub: ConversationHub;
  signal: Signal;
  selections: Map<string, Promise<AlertLifecycleSubjectMatch>>;
  /** Injectable for tests; defaults to the process-wide cache. */
  misses?: SubjectMisses;
}): Promise<SubjectBindOutcome> {
  const { db, tenantId, connector, hub, signal, selections, misses = subjectMisses } = input;
  const lifecycle = connector.alertLifecycle;
  const groupKey = signal.providerGroupKey;
  if (!lifecycle?.monitorForSubject || !lifecycle.readEpisode || !groupKey || !connector.generation)
    return { reason: 'exact_binding_required' };
  const lifecycleVersion = connector.generation.lifecycleVersion;
  // The Slack parser stores the WHATWG-serialised URL in the group key, so the key is normalised.
  // Group keys start with the subject prefix, so they never collide with the signal namespace.
  const missKey = `${connector.id}:${lifecycleVersion}:${groupKey}`;
  const signalMissKey = `${connector.id}:${lifecycleVersion}:signal:${signal.id}`;
  const miss = misses.get(missKey) ?? misses.get(signalMissKey);
  if (miss) return { reason: miss.reason };
  const remember = <T extends { reason: string }>(outcome: T): T => {
    if (SIGNAL_MISS_REASONS.has(outcome.reason))
      misses.set(signalMissKey, { reason: outcome.reason });
    return outcome;
  };
  let selection = selections.get(groupKey);
  if (!selection) {
    selection = lifecycle.monitorForSubject(groupKey);
    selections.set(groupKey, selection);
  }
  const match = await selection;
  if (match.status !== 'matched') {
    // An unreadable inventory is transient and retried next pass; only real answers are kept.
    if (match.reason === 'no_matching_monitor' || match.reason === 'ambiguous_monitor')
      misses.set(missKey, { reason: match.reason });
    return { reason: match.reason };
  }
  const result = await lifecycle.readEpisode({
    monitorId: match.monitorId,
    family: match.family,
    observedAt: signal.firstSeenAt,
  });
  const observation = result.status === 'verified' ? result.observations[0] : undefined;
  if (result.status !== 'verified' || result.observations.length !== 1 || !observation?.startsAt)
    return remember({
      reason: result.status === 'unverified' ? result.reason : 'ambiguous_episode',
    });
  const startsAt = observation.startsAt;
  const outcome = await withTenant(db, tenantId, async (tx): Promise<SubjectBindOutcome> => {
    // The same generation fence as reconciliation: a save, rotation or disable since this pass read
    // the connector must not bind with evidence read under the old configuration.
    const [generation] = await tx
      .select({ id: connectorConfigs.id })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, connector.id),
          eq(connectorConfigs.lifecycleVersion, lifecycleVersion),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .for('share');
    if (!generation) return { reason: 'state_or_generation_changed' };
    // Every signal writer takes the response-group work locks before the incident row lock.
    await lockResponseGroupWorkTx(tx, tenantId, signal.incidentId);
    const [incident] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, signal.incidentId))
      .for('update');
    if (
      !incident ||
      incident.archivedAt ||
      !ACTIVE_STATUSES.includes(incident.status as (typeof ACTIVE_STATUSES)[number])
    )
      return { reason: 'state_or_generation_changed' };
    const [current] = await tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.id, signal.id))
      .for('update');
    // Another pass or writer cleared it as a duplicate after this pass read it; nothing needs review.
    if (current?.state === 'resolved' && current.clearProvenance === 'provider')
      return { settled: true as const };
    if (
      !current ||
      current.version !== signal.version ||
      current.incidentId !== signal.incidentId ||
      current.dataSourceId !== null
    )
      return { reason: 'state_or_generation_changed' };
    const bound = await bindSignalToEpisodeTx(tx, {
      signalId: signal.id,
      dataSourceId: connector.id,
      episode: { ...observation, startsAt },
    });
    if (bound.status === 'conflict') return { reason: 'provider_episode_already_bound' };
    const url = scrubSecrets(groupKey.slice(STATUSCAKE_UPTIME_SUBJECT.length));
    const { message } = await hub.appendTxOnce(tx, tenantId, incident.id, {
      author: 'system',
      content: `Bound this notification to ${observation.provider} uptime test ${match.monitorId}, episode ${startsAt.toISOString()}. It is the only test in this connection that checks ${url}, and ${observation.provider} reports an outage covering the notification. Recovery still requires the provider to report this episode ended.`,
      originMessageId: `connector-subject-binding:${connector.id}:${signal.id}`,
    });
    return { signal: bound.signal, message };
  });
  return 'reason' in outcome ? remember(outcome) : outcome;
}

/**
 * Clears unbound duplicate notices that a verified provider episode covers.
 *
 * @remarks A stock notice is posted per alert, so one outage can leave several unbound Slack signals
 * on the incident, and only one of them can own the episode. A sibling is cleared only when it names
 * the same subject, sits on the same incident, and was first seen inside the ended episode; a notice
 * seen outside it belongs to another outage and must bind its own episode. Siblings stay unbound,
 * so they carry provider provenance without a clear generation.
 * @param tx - Transaction holding the response-group work lock and the incident row lock.
 * @param input - Tenant, hub, the provider-cleared bound signal, and the episode that cleared it.
 */
export async function clearCoveredNoticesTx(
  tx: Tx,
  input: {
    tenantId: string;
    hub: ConversationHub;
    connectorId: string;
    lifecycleVersion: number;
    bound: Signal;
    monitorId: string;
    episode: { provider: string; startsAt: Date; endsAt: Date | null };
  },
) {
  const { tenantId, hub, bound, episode } = input;
  if (
    episode.provider !== 'statuscake' ||
    !episode.endsAt ||
    !bound.providerGroupKey?.startsWith(STATUSCAKE_UPTIME_SUBJECT)
  )
    return [];
  const siblings = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.incidentId, bound.incidentId),
        eq(incidentSignals.surface, 'slack'),
        eq(incidentSignals.provider, 'statuscake'),
        eq(incidentSignals.providerGroupKey, bound.providerGroupKey),
        isNull(incidentSignals.dataSourceId),
        ne(incidentSignals.state, 'resolved'),
        gte(incidentSignals.firstSeenAt, episode.startsAt),
        lte(incidentSignals.firstSeenAt, episode.endsAt),
      ),
    )
    .orderBy(incidentSignals.id)
    .for('update');
  const cleared = [];
  for (const sibling of siblings) {
    const key = `connector-covered-clear:${input.connectorId}:${input.lifecycleVersion}:${sibling.id}:${episode.startsAt.toISOString()}:${episode.endsAt.toISOString()}`;
    const content = `Verified ${episode.provider} recovery for monitor ${input.monitorId}, episode ${episode.startsAt.toISOString()}, also clears this duplicate notice of the same outage.`;
    cleared.push(
      await hub.observeSignalTx(
        tx,
        tenantId,
        {
          incidentId: sibling.incidentId,
          surface: sibling.surface,
          channel: sibling.channel,
          externalMessageId: sibling.externalMessageId,
          state: 'resolved',
          clearProvenance: 'provider',
          summary: content,
          contentHash: createHash('sha256').update(key).digest('hex'),
          eventKey: key,
          eventAt: new Date(),
        },
        content,
      ),
    );
  }
  return cleared;
}
