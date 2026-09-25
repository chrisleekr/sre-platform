import type {
  AlertLifecycleQuery,
  AlertLifecycleResult,
  AlertLifecycleSubjectMatch,
  IDataSourceConnector,
} from '@sre/connectors';
import {
  ACTIVE_STATUSES,
  connectorConfigs,
  incidentSignals,
  incidents,
  lockResponseGroupWorkTx,
  prepareResponseGroupRecoveryTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  bindSignalFromSubject,
  clearCoveredNoticesTx,
  subjectSelectionEligibility,
  type SubjectMisses,
} from './connector-subject-binding';
import { redactInput, scrubSecrets } from './redact';

type ObservedMessage = NonNullable<
  Awaited<ReturnType<ConversationHub['observeSignalTx']>>['message']
>;

export interface ConnectorSignalBinding {
  signalId: string;
  monitorId: string;
  scope?: string;
  family?: string;
  startsAt: string;
  /** Scoped digest of the explicitly entered native cycle, never the raw cycle key. */
  nativeEpisodeKey?: string;
  nativeMonitorIdentity?: string;
}

interface RecoveryQueue {
  insertRecoveryTx(
    tx: Tx,
    tenantId: string,
    incidentId: string,
    lifecycleVersion: number,
    signalFence: string,
  ): Promise<{ jobId: string | null }>;
  publishJob(jobId: string): Promise<void>;
}

// Provider text is tenant-authored and reaches stored signals, so it gets the same scrubbing as the
// native webhook path before storage.
function scrubbedText(values: Record<string, string>): Record<string, string> {
  return redactInput(
    Object.fromEntries(Object.entries(values).map(([name, text]) => [name, scrubSecrets(text)])),
  ) as Record<string, string>;
}

function warn(event: string, fields: Record<string, string | null>, error: unknown): void {
  console.warn(
    JSON.stringify({
      level: 'warn',
      pkg: '@sre/agent-tools',
      event,
      ...fields,
      errorType: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
}

/** Bounded reconciliation of retained exact episodes. Connector inventory absence is never recovery.
 * @param input - Tenant-scoped connector, persistence and recovery dependencies.
 */
export async function reconcileConnectorLifecycle(input: {
  db: Db;
  tenantId: string;
  connector: IDataSourceConnector;
  hub: ConversationHub;
  queue: RecoveryQueue;
  /** Injectable for tests; defaults to the process-wide subject miss cache. */
  subjectMisses?: SubjectMisses;
}): Promise<{ verified: number; unresolved: Array<{ signalId: string; reason: string }> }> {
  const { connector, tenantId, db, hub, queue, subjectMisses } = input;
  const unresolved: Array<{ signalId: string; reason: string }> = [];
  let verified = 0;
  if (!connector.alertLifecycle?.readEpisode || !connector.generation)
    return { verified, unresolved };
  const { rows, bindings } = await withTenant(db, tenantId, async (tx) => {
    const [config] = await tx
      .select()
      .from(connectorConfigs)
      .where(eq(connectorConfigs.id, connector.id));
    const raw = config?.settings as { lifecycleBindings?: ConnectorSignalBinding[] } | undefined;
    const savedBindings = raw?.lifecycleBindings ?? [];
    const progress = (config?.pollCursor as { lifecycle?: { after?: string } } | null)?.lifecycle;
    // Unbound notices share the ordered cursor and the batch bound with bound signals, so the
    // wrap-around visits every eligible row and neither kind can starve the other.
    const eligible = or(
      and(eq(incidentSignals.dataSourceId, connector.id)),
      savedBindings.length
        ? inArray(
            incidentSignals.id,
            savedBindings.map((binding) => binding.signalId),
          )
        : undefined,
      subjectSelectionEligibility(connector),
    );
    const readBatch = (after?: string) =>
      tx
        .select()
        .from(incidentSignals)
        .where(
          and(
            eligible,
            inArray(
              incidentSignals.incidentId,
              tx
                .select({ id: incidents.id })
                .from(incidents)
                .where(
                  and(
                    isNull(incidents.archivedAt),
                    inArray(incidents.status, [...ACTIVE_STATUSES]),
                  ),
                ),
            ),
            after ? gt(incidentSignals.id, after) : undefined,
          ),
        )
        .orderBy(incidentSignals.id)
        .limit(50);
    let batch = await readBatch(progress?.after);
    if (!batch.length && progress?.after) batch = await readBatch();
    return { rows: batch, bindings: savedBindings };
  });
  const selections = new Map<string, Promise<AlertLifecycleSubjectMatch>>();
  // Rows were read before the loop. A cached miss answers without re-reading the row, so a
  // duplicate cleared earlier in this pass is skipped here rather than reported as unresolved.
  const clearedThisPass = new Set<string>();
  // A throw is contained to its signal so later signals and the cursor write still run. The cursor
  // advances past it as it does for provider_read_failed; the wrap-around rescan retries it.
  for (let signal of rows) {
    if (clearedThisPass.has(signal.id)) continue;
    try {
      const binding = bindings.find((entry) => entry.signalId === signal.id);
      if (!binding && !signal.dataSourceId) {
        const selected = await bindSignalFromSubject({
          db,
          tenantId,
          connector,
          hub,
          signal,
          selections,
          misses: subjectMisses,
        });
        if ('settled' in selected) continue;
        if ('reason' in selected) {
          unresolved.push({ signalId: signal.id, reason: selected.reason });
          continue;
        }
        if (selected.message) await hub.publishAppendedBestEffort(selected.message);
        // Verified below with the same exact read a native signal gets.
        signal = selected.signal;
      }
      const labels = signal.labels ?? {};
      const monitorId = binding?.monitorId ?? labels.monitor_id;
      const startsAt = binding ? new Date(binding.startsAt) : signal.startsAt;
      if (!monitorId || !startsAt) {
        unresolved.push({ signalId: signal.id, reason: 'exact_binding_required' });
        continue;
      }
      const query: AlertLifecycleQuery = {
        monitorId,
        startsAt,
        observedAt: new Date(),
        family: binding?.family ?? labels.check_type,
        scope: binding?.scope ?? labels.alert_scope,
      };
      const result: AlertLifecycleResult = await connector.alertLifecycle.readEpisode(query);
      if (result.status !== 'verified' || result.observations.length !== 1) {
        unresolved.push({
          signalId: signal.id,
          reason: result.status === 'unverified' ? result.reason : 'ambiguous_episode',
        });
        continue;
      }
      const observation = result.observations[0]!;
      if (observation.startsAt?.getTime() !== startsAt.getTime()) {
        unresolved.push({ signalId: signal.id, reason: 'episode_mismatch' });
        continue;
      }
      let message: ObservedMessage | null = null;
      const coveredMessages: ObservedMessage[] = [];
      // Marked cleared only after commit, so a rolled-back clear leaves its duplicates for this pass.
      const coveredIds: string[] = [];
      let jobId: string | null = null;
      const applied = await withTenant(db, tenantId, async (tx) => {
        const [generation] = await tx
          .select()
          .from(connectorConfigs)
          .where(
            and(
              eq(connectorConfigs.id, connector.id),
              eq(connectorConfigs.lifecycleVersion, connector.generation!.lifecycleVersion),
              eq(connectorConfigs.enabled, true),
              isNull(connectorConfigs.deletedAt),
            ),
          )
          .for('share');
        if (!generation) return false;
        // Every signal writer takes the response-group work locks before the incident row lock.
        await lockResponseGroupWorkTx(tx, tenantId, signal.incidentId);
        const [incident] = await tx
          .select()
          .from(incidents)
          .where(eq(incidents.id, signal.incidentId))
          .for('update');
        if (!incident || incident.archivedAt || ['closed', 'resolved'].includes(incident.status))
          return false;
        const [current] = await tx
          .select()
          .from(incidentSignals)
          .where(eq(incidentSignals.id, signal.id))
          .for('update');
        if (
          !current ||
          current.version !== signal.version ||
          current.incidentId !== signal.incidentId
        )
          return false;
        const signalSource = {
          kind: 'monitor' as const,
          lifecycleVersion: connector.generation!.lifecycleVersion,
          lifecycleState: observation.status,
          provider: observation.provider,
          dataSourceId: connector.id,
          externalId: monitorId,
          displayName: scrubSecrets(observation.alertName),
          observedAt: new Date().toISOString(),
        };
        if (observation.status === 'firing') {
          await tx
            .update(incidentSignals)
            .set({ signalSource, providerClearGeneration: null })
            .where(eq(incidentSignals.id, signal.id));
          message = (
            await hub.appendTxOnce(tx, tenantId, incident.id, {
              author: 'system',
              content: `Verified ${observation.provider} monitor ${monitorId} is firing. Historical notification state is preserved; recovery is not established.`,
              originMessageId: `connector-firing-verification:${connector.id}:${connector.generation!.lifecycleVersion}:${signal.id}:${signal.version}`,
            })
          ).message;
          return true;
        }
        const key = `connector-reconcile:${connector.id}:${connector.generation!.lifecycleVersion}:${signal.id}:${startsAt.toISOString()}:${observation.endsAt?.toISOString()}`;
        const content = `Verified ${observation.provider} recovery for monitor ${monitorId}, episode ${startsAt.toISOString()}.`;
        const observed = await hub.observeSignalTx(
          tx,
          tenantId,
          {
            incidentId: signal.incidentId,
            surface: signal.surface,
            channel: signal.channel,
            externalMessageId: signal.externalMessageId,
            dataSourceId: connector.id,
            provider: observation.provider,
            providerFingerprint: signal.providerFingerprint ?? observation.fingerprint,
            startsAt,
            endsAt: observation.endsAt,
            labels: scrubbedText(observation.labels),
            annotations: scrubbedText(observation.annotations),
            signalSource,
            state: 'resolved',
            clearProvenance: 'provider',
            summary: content,
            contentHash: createHash('sha256').update(key).digest('hex'),
            eventKey: key,
            eventAt: new Date(),
          },
          content,
        );
        message = observed.message;
        const providerCleared =
          observed.observation.signal.clearProvenance === 'provider' &&
          observed.observation.signal.providerClearGeneration ===
            connector.generation!.lifecycleVersion;
        // Runs on replays too, so a duplicate notice that arrived after the first clear still clears.
        const covered = providerCleared
          ? await clearCoveredNoticesTx(tx, {
              tenantId,
              hub,
              connectorId: connector.id,
              lifecycleVersion: connector.generation!.lifecycleVersion,
              bound: observed.observation.signal,
              monitorId,
              episode: { provider: observation.provider, startsAt, endsAt: observation.endsAt },
            })
          : [];
        for (const entry of covered) {
          // A refused observation leaves the duplicate open, so it must still bind its own episode.
          if (entry.observation.signal.state === 'resolved')
            coveredIds.push(entry.observation.signal.id);
          if (entry.message) coveredMessages.push(entry.message);
        }
        const outcomes = [observed.observation, ...covered.map((entry) => entry.observation)];
        // Every poll replays the same clear. Re-enqueueing a replay would pull a scheduled recheck
        // forward, so only a clear that changed a signal starts recovery. The last outcome was read
        // after every write above, so it reflects the whole incident.
        if (outcomes.some((entry) => entry.applied) && outcomes.at(-1)!.allResolved) {
          const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, signal.incidentId);
          if (recovery)
            jobId = (
              await queue.insertRecoveryTx(
                tx,
                tenantId,
                recovery.rootIncidentId,
                recovery.lifecycleVersion,
                recovery.signalFence,
              )
            ).jobId;
        }
        return providerCleared;
      });
      for (const id of coveredIds) clearedThisPass.add(id);
      if (!applied) unresolved.push({ signalId: signal.id, reason: 'state_or_generation_changed' });
      else verified += 1;
      if (message) await hub.publishAppendedBestEffort(message);
      for (const covered of coveredMessages) await hub.publishAppendedBestEffort(covered);
      // Postgres holds the job; the queue reconciler enqueues it if this publish is lost.
      if (jobId)
        await queue
          .publishJob(jobId)
          .catch((error) =>
            warn('connector_lifecycle.job_publish_failed', { tenantId, jobId }, error),
          );
    } catch (error) {
      unresolved.push({ signalId: signal.id, reason: 'processing_failed' });
      warn(
        'connector_lifecycle.signal_failed',
        { tenantId, connectorId: connector.id, signalId: signal.id },
        error,
      );
    }
  }
  await withTenant(db, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        pollCursor: sql`coalesce(${connectorConfigs.pollCursor}, '{}'::jsonb) || ${JSON.stringify({
          lifecycle: {
            after: rows.at(-1)?.id,
            lastAttemptAt: new Date().toISOString(),
            failureCategory: unresolved[0]?.reason ?? null,
            verified,
          },
        })}::jsonb`,
      })
      .where(
        and(
          eq(connectorConfigs.id, connector.id),
          eq(connectorConfigs.lifecycleVersion, connector.generation!.lifecycleVersion),
        ),
      ),
  );
  for (const gap of unresolved) {
    const signal = rows.find((row) => row.id === gap.signalId);
    if (signal)
      await hub.appendOnce(tenantId, signal.incidentId, {
        author: 'system',
        content:
          gap.reason === 'processing_failed'
            ? 'Provider lifecycle verification failed internally and will be retried on a later poll; no recovery has been inferred.'
            : `Provider lifecycle verification needs review: ${gap.reason}. Review the exact monitor and episode binding in Connections; no recovery has been inferred.`,
        originMessageId: `lifecycle-gap:${connector.id}:${connector.generation!.lifecycleVersion}:${gap.signalId}:${gap.reason}`,
      });
  }
  return { verified, unresolved };
}
