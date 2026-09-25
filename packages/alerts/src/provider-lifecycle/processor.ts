import { retainProviderEpisode } from './retain-episode';
import { updateAcceptedEpisode } from './update-episode';
import { assertAlertConnectorGeneration } from './generation';
import { routeToIncident } from '../route-to-incident';
import {
  acceptAlertEpisodeIntakeTx,
  acceptAlertEpisodeIntake,
  getSignalByProviderEpisode,
  getBindingByExternal,
  threadExternalId,
  activateSurfaceBinding,
  claimAlertEpisodeRootPost,
  getAlertEpisodeIntake,
  isChannelSubscribed,
  getPreviousMonitorEpisodeTx,
  prepareResponseGroupRecoveryTx,
  decideIncidentEpisodeRouteTx,
  joinAlertCohortTx,
  markStaleAlertEpisodeRootUncertain,
  recordAlertEpisodeRootFailure,
  recordAlertEpisodeRootPost,
  recordIncidentRelationTx,
  recordSignalCorrelationDecisionTx,
  withTenant,
  type Tx,
} from '@sre/db';
import { incidentUrl, type HubMessage } from '@sre/hub';
import { SlackApiError } from '@sre/surfaces';

import type { NativeLifecycleOutcome, NativeLifecycleDeps } from './contracts';
import {
  DEFAULT_COHORT_WINDOW_MS,
  ROOT_POST_STALE_MS,
  alertmanagerMonitorKey,
  alertText,
  hash,
  investigationMaterial,
  episodeGroupingPolicy,
  object,
  service,
  severity,
  signalObservation,
  restoreStoredAlertmanagerEpisode,
  storedAlertmanagerObservation,
  string,
  type NormalizedAlert,
} from './normalize';
import { finalizeDeduplicatedEpisode } from './deduplicated-episode';
import { recordAlertmanagerDisposition } from './disposition';

/** Persists an authenticated provider episode through the existing incident opener.
 * @param deps - Tenant persistence, hub and queue dependencies.
 * @param connector - Verified connector generation and delivery configuration.
 * @param incomingGroupKey - Provider group identity.
 * @param incomingExternalUrl - Sanitized provider URL.
 * @param incomingAlert - Provider-owned lifecycle observation.
 * @param observedAt - Platform receipt time, not the provider episode start.
 */
export async function processAlert(
  deps: NativeLifecycleDeps,
  connector: { id: string; tenantId: string; settings: unknown; lifecycleVersion?: number },
  incomingGroupKey: string,
  incomingExternalUrl: string | null,
  incomingAlert: Omit<NormalizedAlert, 'startsAt'> & {
    startsAt: Date | null;
    episodeKey?: string;
    repeatedTrigger?: boolean;
  },
  observedAt: Date,
): Promise<NativeLifecycleOutcome> {
  const settings = object(connector.settings);
  const configuredChannel = string(settings.alertChannel);
  if (!configuredChannel) throw new Error('Prometheus data source has no Slack alert channel');
  const incomingMaterialHash = hash(investigationMaterial(incomingAlert));
  const stored = storedAlertmanagerObservation(
    incomingGroupKey,
    incomingExternalUrl,
    incomingAlert,
    connector.lifecycleVersion,
  );
  const { groupingWindowMs, maxIncidentAgeMs } = episodeGroupingPolicy(settings);
  const retainedIntake = await retainProviderEpisode(deps.appDb, connector, {
    dataSourceId: connector.id,
    providerFingerprint: incomingAlert.fingerprint,
    startsAt: incomingAlert.startsAt,
    opaqueEpisodeKey: incomingAlert.episodeKey,
    repeatedTrigger: incomingAlert.repeatedTrigger,
    materialHash: incomingMaterialHash,
    observation: stored,
    channel: configuredChannel,
    observedAt,
  });
  if (!retainedIntake) return 'acknowledged';
  let intake = retainedIntake;
  if (intake.failureCategory === 'native_cycle_association_required')
    return 'native_cycle_association_required';
  if (intake.failureCategory === 'binding_episode_mismatch') return 'binding_episode_mismatch';
  if (intake.failureCategory === 'conflicting_episode_times') return 'conflicting_episode_times';
  if (!intake.startsAt) return 'deferred';
  let episode = restoreStoredAlertmanagerEpisode(intake);

  if (
    intake.state === 'posting' &&
    intake.updatedAt.getTime() <= observedAt.getTime() - ROOT_POST_STALE_MS
  ) {
    if (
      await markStaleAlertEpisodeRootUncertain(
        deps.appDb,
        connector.tenantId,
        intake.id,
        new Date(observedAt.getTime() - ROOT_POST_STALE_MS),
      )
    )
      throw new SlackApiError(
        'uncertain',
        'process_interrupted',
        'Slack root creation was interrupted and its remote outcome is unknown',
      );
    intake = (await getAlertEpisodeIntake(deps.appDb, connector.tenantId, intake.id)) ?? intake;
    episode = restoreStoredAlertmanagerEpisode(intake);
  }

  if (intake.state === 'pending' || intake.state === 'rejected') {
    const existing = await getSignalByProviderEpisode(
      deps.appDb,
      connector.tenantId,
      connector.id,
      episode.alert.fingerprint,
      episode.alert.startsAt,
    );
    if (existing?.surface === 'slack') {
      await withTenant(deps.appDb, connector.tenantId, async (tx) => {
        await assertAlertConnectorGeneration(tx, connector);
        const root = existing.externalMessageId.split('#')[0]!;
        const binding = await getBindingByExternal(
          tx,
          connector.tenantId,
          'slack',
          threadExternalId({ channel: existing.channel, threadId: root }),
        );
        if (
          !binding ||
          binding.incidentId !== existing.incidentId ||
          binding.channel !== episode.channel
        )
          throw new Error('explicit provider episode has no matching subscribed source thread');
        if (await claimAlertEpisodeRootPost(tx, connector.tenantId, intake.id)) {
          await recordAlertEpisodeRootPost(tx, connector.tenantId, intake.id, root);
          await acceptAlertEpisodeIntake(
            tx,
            connector.tenantId,
            intake.id,
            existing.incidentId,
            binding.id,
          );
        }
      });
      intake = (await getAlertEpisodeIntake(deps.appDb, connector.tenantId, intake.id)) ?? intake;
      episode = restoreStoredAlertmanagerEpisode(intake);
    }
  }
  if (intake.state === 'accepted' && intake.incidentId) {
    await updateAcceptedEpisode(
      deps,
      connector.tenantId,
      connector.id,
      intake.incidentId,
      episode.groupKey,
      episode.alert,
      episode.materialHash,
      observedAt,
      { channel: episode.channel, threadId: intake.rootMessageId! },
      connector.lifecycleVersion,
      intake.observation.lifecycleVersion,
    );
    return 'accepted';
  }
  if (intake.state === 'pending' || intake.state === 'rejected') {
    if (!(await isChannelSubscribed(deps.appDb, connector.tenantId, 'slack', episode.channel)))
      return 'unsubscribed';
    if (!(await claimAlertEpisodeRootPost(deps.appDb, connector.tenantId, intake.id)))
      return 'retry';
    try {
      const rootMessageId = await deps.postAlertRoot(
        connector.tenantId,
        episode.channel,
        alertText(episode.alert),
        intake.id,
      );
      if (
        !(await recordAlertEpisodeRootPost(
          deps.appDb,
          connector.tenantId,
          intake.id,
          rootMessageId,
        ))
      )
        throw new Error('alert root post lost its durable state fence');
    } catch (error) {
      const uncertain = !(error instanceof SlackApiError) || error.certainty === 'uncertain';
      await recordAlertEpisodeRootFailure(
        deps.appDb,
        connector.tenantId,
        intake.id,
        uncertain ? 'uncertain' : 'rejected',
        error instanceof SlackApiError ? error.code : 'unexpected_poster_failure',
      );
      throw error;
    }
    intake = (await getAlertEpisodeIntake(deps.appDb, connector.tenantId, intake.id)) ?? intake;
    episode = restoreStoredAlertmanagerEpisode(intake);
  }
  if (intake.state === 'posting') return 'retry';
  if (intake.state === 'uncertain') return 'deferred';
  if (intake.state !== 'posted' || !intake.rootMessageId)
    throw new Error(`alert intake cannot route from ${intake.state}`);
  // Recheck after recording a successful post; revocation must not turn it into an uncertain send.
  if (!(await isChannelSubscribed(deps.appDb, connector.tenantId, 'slack', episode.channel)))
    return 'unsubscribed';
  const { alert, channel, groupKey, materialHash } = episode;
  const monitorKey = alertmanagerMonitorKey(connector.id, alert);
  const episodeKey = `${alert.provider ?? 'alertmanager'}:${connector.id}:${alert.fingerprint}:${alert.startsAt.toISOString()}`;
  const incidentFingerprint = hash({
    connectorId: connector.id,
    fingerprint: alert.fingerprint,
    startsAt: alert.startsAt.toISOString(),
  });
  const relationshipMessages: HubMessage[] = [];
  const routedEffects: {
    message: HubMessage | null;
    jobId: string | null;
    recoveryJobId: string | null;
    cohortJobId: string | null;
  } = {
    message: null,
    jobId: null,
    recoveryJobId: null,
    cohortJobId: null,
  };
  const result = await routeToIncident(deps.route, {
    resolutionPolicy: 'provider_clear',
    tenantId: connector.tenantId,
    source:
      alert.provider === undefined || alert.provider === 'alertmanager'
        ? 'prometheus'
        : alert.provider,
    fingerprint: incidentFingerprint,
    dedupKey: episodeKey,
    service: service(alert.labels),
    severity: severity(alert.labels),
    title: (alert.annotations.summary || alert.alertName).slice(0, 512),
    origin: { surface: 'slack', channel, threadId: intake.rootMessageId },
    opener: {
      author: 'system',
      content: alertText(alert),
      originSurface: 'slack',
      originMessageId: episodeKey,
    },
    context: {
      provider: alert.provider ?? 'alertmanager',
      ...intake.observation,
      fingerprint: alert.fingerprint,
    },
    investigationTrigger: {
      reason: 'new_episode',
      automatic: true,
      monitorKey,
    },
    resolveIncidentRouteTx: async (tx, requestedFingerprint) => {
      const decision = await decideIncidentEpisodeRouteTx(tx, connector.tenantId, {
        dataSourceId: connector.id,
        subjectKey: monitorKey,
        observedAt,
        groupingWindowMs,
        maxIncidentAgeMs,
        allowGrouping: false,
      });
      return {
        fingerprint: decision.incident?.fingerprint ?? requestedFingerprint,
        ...(decision.incident ? { bindingRole: 'source' as const } : {}),
        correlationDecision: decision,
      };
    },
    signal: signalObservation(
      connector.id,
      groupKey,
      alert,
      materialHash,
      observedAt,
      intake.observation.lifecycleVersion,
    ),
    onRoutedTx: async (tx: Tx, routed) => {
      await assertAlertConnectorGeneration(tx, connector);
      let signalId = routed.signalId;
      if (routed.reused) {
        const observed = await deps.hub.observeSignalTx(
          tx,
          connector.tenantId,
          {
            incidentId: routed.incidentId,
            ...signalObservation(
              connector.id,
              groupKey,
              alert,
              materialHash,
              observedAt,
              intake.observation.lifecycleVersion,
            ),
          },
          alertText(alert),
        );
        if (!observed.observation.applied)
          throw new Error('new provider episode did not produce a durable signal');
        signalId = observed.observation.signal.id;
        routedEffects.message = observed.message;
        await activateSurfaceBinding(
          tx,
          connector.tenantId,
          'slack',
          routed.incidentId,
          routed.bindingId,
        );
        routedEffects.jobId = (
          await deps.route.queue.insertReassessmentTx(
            tx,
            connector.tenantId,
            routed.incidentId,
            signalId,
            observed.observation.signal.version,
            'material_change',
          )
        ).jobId;
      }
      if (!signalId) throw new Error('provider episode route has no durable signal');
      if (alert.status === 'resolved') {
        const recovery = await prepareResponseGroupRecoveryTx(
          tx,
          connector.tenantId,
          routed.incidentId,
        );
        // Separate from jobId: a reused incident also queued a reassessment that must be published.
        if (recovery)
          routedEffects.recoveryJobId = (
            await deps.route.queue.insertRecoveryTx(
              tx,
              connector.tenantId,
              recovery.rootIncidentId,
              recovery.lifecycleVersion,
              recovery.signalFence,
            )
          ).jobId;
      }
      if (!routed.correlationDecision)
        throw new Error('provider episode route has no correlation decision');
      await recordSignalCorrelationDecisionTx(tx, signalId, routed.correlationDecision);
      if (!(await acceptAlertEpisodeIntakeTx(tx, intake.id, routed.incidentId, routed.bindingId)))
        throw new Error('alert intake lost its incident acceptance fence');
      const windowSeconds = Number(settings.cohortWindowSec);
      const windowMs =
        Number.isFinite(windowSeconds) && windowSeconds >= 30 && windowSeconds <= 600
          ? windowSeconds * 1_000
          : DEFAULT_COHORT_WINDOW_MS;
      const cohort = await joinAlertCohortTx(tx, connector.tenantId, {
        sourceScopeKey: `connector:${connector.id}`,
        dataSourceId: connector.id,
        signalId,
        observedAt,
        windowMs,
      });
      if (cohort.state === 'collecting')
        routedEffects.cohortJobId = (
          await deps.route.queue.insertCohortAnalysisTx(
            tx,
            connector.tenantId,
            cohort.id,
            new Date(cohort.windowEndsAt.getTime() + 2_000),
          )
        ).jobId;
      const previous = await getPreviousMonitorEpisodeTx(
        tx,
        connector.id,
        monitorKey,
        alert.startsAt,
        signalId,
      );
      if (previous && previous.incidentId !== routed.incidentId)
        await recordIncidentRelationTx(tx, connector.tenantId, {
          sourceIncidentId: routed.incidentId,
          targetIncidentId: previous.incidentId,
          type: 'recurrence_of',
          rationale: 'The provider reported a new episode from the same monitor rule.',
          evidence: [
            `monitor_key:${monitorKey}`,
            `provider_fingerprint:${alert.fingerprint}`,
            `previous_starts_at:${previous.startsAt?.toISOString() ?? 'unknown'}`,
            `current_starts_at:${alert.startsAt.toISOString()}`,
          ],
          decidedBy: 'system',
        });
      if (previous && previous.incidentId !== routed.incidentId) {
        const previousId = previous.incidentId;
        const previousUrl = incidentUrl(deps.dashboardBaseUrl, previousId) ?? previousId;
        relationshipMessages.push(
          (
            await deps.hub.appendTxOnce(tx, connector.tenantId, routed.incidentId, {
              author: 'system',
              kind: 'relationship',
              content: `Recurring monitor rule. Prior incident: ${previousUrl}. This firing remains a separate investigation.`,
              originMessageId: `alertmanager:relationships:${signalId}`,
            })
          ).message,
        );

        relationshipMessages.push(
          (
            await deps.hub.appendTxOnce(tx, connector.tenantId, previousId, {
              author: 'system',
              kind: 'relationship',
              content: `A new firing from this monitor rule opened a separate incident: ${incidentUrl(deps.dashboardBaseUrl, routed.incidentId) ?? routed.incidentId}.`,
              originMessageId: `alertmanager:relationship-backlink:${signalId}:${previousId}`,
            })
          ).message,
        );
      }
    },
  });
  if (result.incidentId)
    await recordAlertmanagerDisposition({
      db: deps.appDb,
      tenantId: connector.tenantId,
      connectorId: connector.id,
      incidentId: result.incidentId,
      channel,
      threadId: intake.rootMessageId,
      eventKey: `${episodeKey}:${alert.status}:${materialHash}`,
      signalKey: episodeKey,
      observedAt,
      alert,
    });

  const messageToPublish = routedEffects.message;
  if (messageToPublish)
    await deps.hub.publishAppended(messageToPublish).catch((error) =>
      deps.log?.error('Alertmanager signal publish failed; durable replay will recover', {
        tenantId: connector.tenantId,
        incidentId: messageToPublish.incidentId,
        operation: 'hub_publish',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  const jobToPublish = routedEffects.jobId;
  if (jobToPublish)
    await deps.route.queue.publishJob(jobToPublish).catch((error) =>
      deps.log?.error(
        'Alertmanager reassessment publish failed; queue reconciliation will recover',
        {
          tenantId: connector.tenantId,
          jobId: jobToPublish,
          operation: 'job_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        },
      ),
    );
  const recoveryJobToPublish = routedEffects.recoveryJobId;
  if (recoveryJobToPublish)
    await deps.route.queue.publishJob(recoveryJobToPublish).catch((error) =>
      deps.log?.error('Provider recovery publish failed; queue reconciliation will recover', {
        tenantId: connector.tenantId,
        jobId: recoveryJobToPublish,
        operation: 'job_publish',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );
  const cohortJobToPublish = routedEffects.cohortJobId;
  if (cohortJobToPublish)
    await deps.route.queue.publishJob(cohortJobToPublish).catch((error) =>
      deps.log?.error('Alert cohort analysis publish failed; queue reconciliation will recover', {
        tenantId: connector.tenantId,
        jobId: cohortJobToPublish,
        operation: 'job_publish',
        errorType: error instanceof Error ? error.name : typeof error,
      }),
    );

  await Promise.all(
    relationshipMessages.map((message) =>
      deps.hub.publishAppended(message).catch((error) =>
        deps.log?.error('Alertmanager relationship publish failed; durable replay will recover', {
          tenantId: connector.tenantId,
          incidentId: message.incidentId,
          operation: 'hub_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      ),
    ),
  );

  if (result.deduped) await finalizeDeduplicatedEpisode(deps, connector, intake, alert);
  return 'accepted';
}
