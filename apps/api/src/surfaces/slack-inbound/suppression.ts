import {
  SLACK_CLASSIFY_SUPPRESSED,
  slackClassifyReservationKey,
  type InboundCandidate,
  type InboundSuppressionReason,
  writeSlackClassifyReservation,
} from '@sre/connectors';
import {
  cancelSurfaceMessageClassificationsTx,
  repairSurfaceInboundIdentityTx,
  setSurfaceMessageTerminalDispositionTx,
  withSurfaceInboundMessageLock,
} from '@sre/db';
import type { SlackConfig, SlackInboundDeps } from './contracts';

const SUPPRESSION_TTL_SEC = 86_400;
/**
 * Supersedes pending classification without changing durable provider signals.
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
  await writeSlackClassifyReservation(
    deps.reservationRedis,
    slackClassifyReservationKey(config.tenantId, candidate.channel, candidate.externalId),
    SLACK_CLASSIFY_SUPPRESSED,
    candidate.eventAt,
    candidate.eventVersion,
    SUPPRESSION_TTL_SEC,
  ).catch((error) => deps.onError?.(error, { configId }));
}
