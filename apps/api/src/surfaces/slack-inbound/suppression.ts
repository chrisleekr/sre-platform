import { scrubSecrets } from '@sre/agent-tools';
import {
  SLACK_CLASSIFY_SUPPRESSED,
  slackClassifyReservationKey,
  type InboundCandidate,
  type InboundSuppressionReason,
  writeSlackClassifyReservation,
} from '@sre/connectors';
import {
  cancelSurfaceMessageClassificationsTx,
  getSignalByExternal,
  listSignalsByExternalRoot,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  prepareResponseGroupRecoveryTx,
  repairSurfaceInboundIdentityTx,
  setSurfaceMessageTerminalDispositionTx,
  withSurfaceInboundMessageLock,
  withTenant,
  type Tx,
} from '@sre/db';
import type { HubMessage } from '@sre/hub';
import { createHash } from 'node:crypto';
import type { SlackConfig, SlackInboundDeps } from './contracts';

const SUPPRESSION_TTL_SEC = 86_400;
const TARGET_LOCK_RETRIES = 3;

class SuppressionTargetMovedError extends Error {}

async function readTargets(tx: Tx, tenantId: string, channel: string, externalMessageId: string) {
  const [plain, grouped] = await Promise.all([
    getSignalByExternal(tx, tenantId, 'slack', channel, externalMessageId),
    listSignalsByExternalRoot(tx, tenantId, 'slack', channel, externalMessageId),
  ]);
  return [
    ...new Map([plain, ...grouped].filter(Boolean).map((row) => [row!.id, row!])).values(),
  ].filter((signal) => signal.state !== 'resolved');
}

async function reconcileSuppressedSignals(
  deps: SlackInboundDeps,
  config: SlackConfig,
  candidate: InboundCandidate,
  reason: InboundSuppressionReason,
): Promise<{ messages: HubMessage[]; jobIds: string[] }> {
  for (let attempt = 1; attempt <= TARGET_LOCK_RETRIES; attempt += 1) {
    try {
      return await withTenant(deps.appDb, config.tenantId, async (tx) => {
        await lockCausalGraphTx(tx, config.tenantId);
        const initial = await readTargets(
          tx,
          config.tenantId,
          candidate.channel,
          candidate.externalId,
        );
        const lockedIncidentIds = [...new Set(initial.map((signal) => signal.incidentId))].sort();
        await lockIncidentWorkTx(tx, config.tenantId, lockedIncidentIds);
        const targets = await readTargets(
          tx,
          config.tenantId,
          candidate.channel,
          candidate.externalId,
        );
        if (targets.some((signal) => !lockedIncidentIds.includes(signal.incidentId)))
          throw new SuppressionTargetMovedError();

        const content = 'Provider control notification suppressed by the inbound adapter.';
        const scrubbedText = scrubSecrets(candidate.text);
        const contentHash = createHash('sha256').update(`${reason}\n${scrubbedText}`).digest('hex');
        const messages: HubMessage[] = [];
        const jobIds = new Set<string>();
        const incidents = new Map<
          string,
          { allResolved: boolean; signals: Array<{ id: string; version: number }> }
        >();
        for (const signal of targets) {
          const result = await deps.hub.observeSignalTx(
            tx,
            config.tenantId,
            {
              incidentId: signal.incidentId,
              surface: signal.surface,
              channel: signal.channel,
              externalMessageId: signal.externalMessageId,
              state: 'resolved',
              summary: content,
              contentHash,
              eventKey: `${candidate.eventKey}:suppression:${reason}:${signal.id}`,
              eventAt: new Date(candidate.eventAt),
              eventVersion: candidate.eventVersion,
            },
            content,
          );
          if (result.observation.signal.incidentId !== signal.incidentId)
            throw new SuppressionTargetMovedError();
          if (result.message) messages.push(result.message);
          if (!result.observation.applied) continue;
          const state = incidents.get(signal.incidentId) ?? { allResolved: false, signals: [] };
          state.allResolved = result.observation.allResolved;
          state.signals.push({
            id: result.observation.signal.id,
            version: result.observation.signal.version,
          });
          incidents.set(signal.incidentId, state);
        }

        for (const [incidentId, state] of incidents) {
          if (state.allResolved) {
            const recovery = await prepareResponseGroupRecoveryTx(tx, config.tenantId, incidentId);
            if (!recovery) continue;
            const { jobId } = await deps.queue.insertRecoveryTx(
              tx,
              config.tenantId,
              recovery.rootIncidentId,
              recovery.lifecycleVersion,
              recovery.signalFence,
            );
            if (jobId) jobIds.add(jobId);
            continue;
          }
          for (const signal of state.signals) {
            const { jobId } = await deps.queue.insertReassessmentTx(
              tx,
              config.tenantId,
              incidentId,
              signal.id,
              signal.version,
              'state_transition',
            );
            if (jobId) jobIds.add(jobId);
          }
        }
        return { messages, jobIds: [...jobIds] };
      });
    } catch (error) {
      if (!(error instanceof SuppressionTargetMovedError) || attempt === TARGET_LOCK_RETRIES)
        throw error;
    }
  }
  throw new Error('suppression target locking exhausted');
}

/**
 * Supersedes pending classification and retires any signals admitted before the correction arrived.
 *
 * @param deps - Slack persistence, hub, queue, and reservation dependencies.
 * @param config - Verified tenant and Slack app routing configuration.
 * @param candidate - Stable surface identity retained by the adapter suppression result.
 * @param reason - Adapter-owned reason stored as the terminal disposition.
 */
export async function applySlackInboundSuppression(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  candidate: InboundCandidate,
  reason: InboundSuppressionReason,
): Promise<void> {
  const disposition = `suppressed_${reason}`;
  const identity = {
    tenantId: config.tenantId,
    surface: 'slack',
    channel: candidate.channel,
    externalMessageId: candidate.externalId,
  };
  const terminalApplied = await withSurfaceInboundMessageLock(
    deps.adminDb,
    identity,
    async (tx) => {
      if (candidate.intakeId) {
        await repairSurfaceInboundIdentityTx(tx, {
          ...identity,
          intakeId: candidate.intakeId,
        });
      }
      const terminalDecision = await setSurfaceMessageTerminalDispositionTx(tx, {
        ...identity,
        disposition,
        eventAt: new Date(candidate.eventAt),
        eventVersion: candidate.eventVersion,
      });
      if (terminalDecision.status === 'stale') return false;
      await cancelSurfaceMessageClassificationsTx(tx, {
        ...identity,
        eventAt: new Date(candidate.eventAt),
        eventVersion: candidate.eventVersion,
      });
      return true;
    },
  );
  if (!terminalApplied) return;
  const reconciled = await reconcileSuppressedSignals(deps, config, candidate, reason);
  await writeSlackClassifyReservation(
    deps.reservationRedis,
    slackClassifyReservationKey(config.tenantId, candidate.channel, candidate.externalId),
    SLACK_CLASSIFY_SUPPRESSED,
    candidate.eventAt,
    candidate.eventVersion,
    SUPPRESSION_TTL_SEC,
  ).catch((error) => deps.onError?.(error, { configId }));
  for (const message of reconciled.messages)
    await deps.hub
      .publishAppended(message)
      .catch((error) => deps.onError?.(error, { configId, incidentId: message.incidentId }));
  for (const jobId of reconciled.jobIds)
    await deps.queue.publishJob(jobId).catch((error) => deps.onError?.(error, { configId }));
}
