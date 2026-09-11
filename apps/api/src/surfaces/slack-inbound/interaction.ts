import { SLACK_LIFECYCLE_ACTION_PREFIX } from '@sre/surfaces';
import { createHash } from 'node:crypto';
import { applyApprovalDecision } from '../../approval-decision';
import type {
  SlackConfig,
  SlackInboundDeps,
  SlackInteraction,
  SlackProcessorOutcome,
} from './contracts';
import { resolveAuthorUserId } from './support';

export async function processSlackInteraction(
  deps: SlackInboundDeps,
  configId: string,
  config: SlackConfig,
  payload: SlackInteraction,
): Promise<SlackProcessorOutcome> {
  if (payload.type !== 'block_actions') return 'dropped_no_candidate';
  const action = payload.actions?.[0];
  const actionId = action?.action_id ?? '';
  const raw = action?.value;
  const value = typeof raw === 'string' ? raw : '';
  const authorUserId = await resolveAuthorUserId(deps, config, 'slack', payload.user?.id ?? '');
  if (actionId.startsWith(SLACK_LIFECYCLE_ACTION_PREFIX)) {
    let command: { incidentId?: unknown; to?: unknown; expectedVersion?: unknown };
    try {
      command = JSON.parse(value) as typeof command;
    } catch {
      return 'dropped_no_candidate';
    }
    const statuses = new Set(['open', 'mitigated', 'resolved', 'closed']);
    if (
      typeof command.incidentId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(command.incidentId) ||
      typeof command.to !== 'string' ||
      !statuses.has(command.to) ||
      !Number.isInteger(command.expectedVersion) ||
      (command.expectedVersion as number) < 0 ||
      actionId !== `${SLACK_LIFECYCLE_ACTION_PREFIX}${command.to}`
    )
      return 'dropped_no_candidate';
    if (!authorUserId) return 'dropped_unauthorized';
    const actionKey =
      action?.action_ts ??
      payload.trigger_id ??
      createHash('sha256').update(`${actionId}\0${value}`).digest('hex');
    const verb =
      command.to === 'mitigated'
        ? 'marked mitigated'
        : command.to === 'open'
          ? 'reopened'
          : command.to;
    await deps.hub.transitionIncident(config.tenantId, command.incidentId, {
      to: command.to as 'open' | 'mitigated' | 'resolved' | 'closed',
      reason: `Responder ${verb} the incident from Slack.`,
      transitionKey: `slack-lifecycle:${config.tenantId}:${actionKey}`,
      author: 'human',
      originSurface: 'slack',
      authorUserId,
      expectedVersion: command.expectedVersion as number,
    });
    return 'interaction_processed';
  }
  const separator = value.indexOf(':');
  const approvalId = separator === -1 ? value : value.slice(0, separator);
  const optionId = value.slice(separator + 1);
  const decidedBy = payload.user?.username ?? payload.user?.id ?? 'slack';
  await applyApprovalDecision(
    {
      adminDb: deps.adminDb,
      appDb: deps.appDb,
      hub: deps.hub,
      queue: deps.queue,
      onError: (error, incidentId) => deps.onError?.(error, { configId, incidentId }),
    },
    {
      tenantId: config.tenantId,
      approvalId,
      optionId,
      decidedBy,
      originSurface: 'slack',
      authorUserId,
    },
  );
  return 'interaction_processed';
}
