import { routeToIncident } from '@sre/alerts';
import {
  acceptAlertEpisodeIntakeTx,
  activateSurfaceBinding,
  claimAlertEpisodeRootPost,
  getAlertEpisodeIntake,
  getIncidentLifecycleTx,
  getPreviousMonitorEpisodeTx,
  prepareResponseGroupRecoveryTx,
  decideIncidentEpisodeRouteTx,
  joinAlertCohortTx,
  markStaleAlertEpisodeRootUncertain,
  recordAlertEpisodeRootFailure,
  recordAlertEpisodeRootPost,
  recordIncidentRelationTx,
  recordSignalCorrelationDecisionTx,
  upsertAlertEpisodeIntake,
  withTenant,
  type Tx,
} from '@sre/db';
import { incidentUrl, type HubMessage } from '@sre/hub';
import { SlackApiError } from '@sre/surfaces';

import type { AlertmanagerWebhookDeps } from '../alertmanager-webhook';
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

async function updateAcceptedEpisode(
  deps: AlertmanagerWebhookDeps,
  tenantId: string,
  connectorId: string,
  incidentId: string,
  groupKey: string,
  alert: NormalizedAlert,
  materialHash: string,
  observedAt: Date,
  thread: { channel: string; threadId: string },
): Promise<void> {
  let currentIncidentId = incidentId;
  for (let attempt = 0; attempt < 2; attempt++) {
    let message: HubMessage | null = null;
    let jobId: string | null = null;
    let movedTo: string | null = null;
    await withTenant(deps.appDb, tenantId, async (tx) => {
      const observed = await deps.hub.observeSignalTx(
        tx,
        tenantId,
        {
          incidentId: currentIncidentId,
          ...signalObservation(connectorId, groupKey, alert, materialHash, observedAt),
        },
        alertText(alert),
      );
      message = observed.message;
      if (!observed.observation.applied) {
        // A human merge can move the episode after this delivery read its intake. Retry against the
        // signal's current owner in a fresh transaction so the provider update is not silently lost.
        if (!observed.message && observed.observation.signal.incidentId !== currentIncidentId)
          movedTo = observed.observation.signal.incidentId;
        return;
      }
      const lifecycle = await getIncidentLifecycleTx(tx, currentIncidentId);
      if (!lifecycle) throw new Error('provider episode incident disappeared');
      if (observed.observation.allResolved) {
        const recovery = await prepareResponseGroupRecoveryTx(tx, tenantId, currentIncidentId);
        if (!recovery) return;
        jobId = (
          await deps.route.queue.insertRecoveryTx(
            tx,
            tenantId,
            recovery.rootIncidentId,
            recovery.lifecycleVersion,
            recovery.signalFence,
          )
        ).jobId;
      } else {
        jobId = (
          await deps.route.queue.insertReassessmentTx(
            tx,
            tenantId,
            currentIncidentId,
            observed.observation.signal.id,
            observed.observation.signal.version,
            observed.observation.investigationTriggerReason,
          )
        ).jobId;
      }
    });
    if (movedTo) {
      currentIncidentId = movedTo;
      continue;
    }
    if (message)
      await deps.hub.publishAppended(message).catch((error) =>
        deps.log?.error('Alertmanager signal publish failed; durable replay will recover', {
          tenantId,
          incidentId: currentIncidentId,
          operation: 'hub_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    if (jobId)
      await deps.route.queue.publishJob(jobId).catch((error) =>
        deps.log?.error('Alertmanager job publish failed; queue reconciliation will recover', {
          tenantId,
          incidentId: currentIncidentId,
          jobId,
          operation: 'job_publish',
          errorType: error instanceof Error ? error.name : typeof error,
        }),
      );
    await recordAlertmanagerDisposition({
      db: deps.appDb,
      tenantId,
      connectorId,
      incidentId: currentIncidentId,
      channel: thread.channel,
      threadId: thread.threadId,
      eventKey: `alertmanager:${connectorId}:${alert.fingerprint}:${alert.startsAt.toISOString()}:${alert.status}:${materialHash}`,
      signalKey: `alertmanager:${connectorId}:${alert.fingerprint}:${alert.startsAt.toISOString()}`,
      observedAt,
      alert,
    });
    return;
  }
  throw new Error('provider episode moved repeatedly during update');
}

export async function processAlert(
  deps: AlertmanagerWebhookDeps,
  connector: { id: string; tenantId: string; settings: unknown },
  incomingGroupKey: string,
  incomingExternalUrl: string | null,
  incomingAlert: NormalizedAlert,
  observedAt: Date,
): Promise<'accepted' | 'deferred' | 'retry'> {
  const settings = object(connector.settings);
  const configuredChannel = string(settings.alertChannel);
  if (!configuredChannel) throw new Error('Prometheus data source has no Slack alert channel');
  const incomingMaterialHash = hash(investigationMaterial(incomingAlert));
  const stored = storedAlertmanagerObservation(
    incomingGroupKey,
    incomingExternalUrl,
    incomingAlert,
  );
  const { groupingWindowMs, maxIncidentAgeMs } = episodeGroupingPolicy(settings);
  let intake = await upsertAlertEpisodeIntake(deps.appDb, connector.tenantId, {
    dataSourceId: connector.id,
    providerFingerprint: incomingAlert.fingerprint,
    startsAt: incomingAlert.startsAt,
    materialHash: incomingMaterialHash,
    observation: stored,
    channel: configuredChannel,
    observedAt,
  });
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
    );
    return 'accepted';
  }

  if (intake.state === 'pending' || intake.state === 'rejected') {
    if (!(await claimAlertEpisodeRootPost(deps.appDb, connector.tenantId, intake.id)))
      return 'retry';
    try {
      const rootMessageId = await deps.postAlertRoot(
        connector.tenantId,
        episode.channel,
        alertText(episode.alert),
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

  const { alert, channel, groupKey, materialHash } = episode;
  const monitorKey = alertmanagerMonitorKey(connector.id, alert);
  const episodeKey = `alertmanager:${connector.id}:${alert.fingerprint}:${alert.startsAt.toISOString()}`;
  const incidentFingerprint = hash({
    connectorId: connector.id,
    fingerprint: alert.fingerprint,
    startsAt: alert.startsAt.toISOString(),
  });
  const relationshipMessages: HubMessage[] = [];
  const routedEffects: {
    message: HubMessage | null;
    jobId: string | null;
    cohortJobId: string | null;
  } = {
    message: null,
    jobId: null,
    cohortJobId: null,
  };
  const result = await routeToIncident(deps.route, {
    tenantId: connector.tenantId,
    source: 'prometheus',
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
    context: { provider: 'alertmanager', ...intake.observation, fingerprint: alert.fingerprint },
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
    signal: signalObservation(connector.id, groupKey, alert, materialHash, observedAt),
    onRoutedTx: async (tx: Tx, routed) => {
      let signalId = routed.signalId;
      if (routed.reused) {
        const observed = await deps.hub.observeSignalTx(
          tx,
          connector.tenantId,
          {
            incidentId: routed.incidentId,
            ...signalObservation(connector.id, groupKey, alert, materialHash, observedAt),
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
          rationale: 'Alertmanager reported a new episode from the same monitor rule.',
          evidence: [
            `monitor_key:${monitorKey}`,
            `provider_fingerprint:${alert.fingerprint}`,
            `previous_starts_at:${previous.startsAt?.toISOString() ?? 'unknown'}`,
            `current_starts_at:${alert.startsAt.toISOString()}`,
          ],
          decidedBy: 'system',
        });
      if (previous && previous.incidentId !== routed.incidentId) {
        const previousId =
          previous && previous.incidentId !== routed.incidentId ? previous.incidentId : null;
        const previousUrl = previousId
          ? (incidentUrl(deps.dashboardBaseUrl, previousId) ?? previousId)
          : null;
        relationshipMessages.push(
          (
            await deps.hub.appendTxOnce(tx, connector.tenantId, routed.incidentId, {
              author: 'system',
              kind: 'relationship',
              content: [
                previousUrl
                  ? `Recurring monitor rule. Prior incident: ${previousUrl}. This firing remains a separate investigation.`
                  : null,
              ]
                .filter(Boolean)
                .join('\n'),
              originMessageId: `alertmanager:relationships:${signalId}`,
            })
          ).message,
        );

        const backlinkNotices = new Map<string, string[]>();
        if (previousId) {
          const notices = backlinkNotices.get(previousId) ?? [];
          notices.push(
            `A new firing from this monitor rule opened a separate incident: ${incidentUrl(deps.dashboardBaseUrl, routed.incidentId) ?? routed.incidentId}.`,
          );
          backlinkNotices.set(previousId, notices);
        }
        for (const [relatedIncidentId, notices] of backlinkNotices) {
          relationshipMessages.push(
            (
              await deps.hub.appendTxOnce(tx, connector.tenantId, relatedIncidentId, {
                author: 'system',
                kind: 'relationship',
                content: notices.join('\n'),
                originMessageId: `alertmanager:relationship-backlink:${signalId}:${relatedIncidentId}`,
              })
            ).message,
          );
        }
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
