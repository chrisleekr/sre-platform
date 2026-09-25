import { getAlertEpisodeIntake, type Db } from '@sre/db';
import type { SlackConfig, SlackEnvelope } from './contracts';

const MARKER = /^sre-alert-root:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** Verifies native root ownership without changing its external-post fence. */
export async function isNativeAlertOpener(
  db: Db,
  config: SlackConfig,
  envelope: SlackEnvelope,
): Promise<boolean> {
  const event = envelope.event;
  if (
    envelope.type !== 'event_callback' ||
    event?.type !== 'message' ||
    !event.channel ||
    !config.botId
  )
    return false;
  const message = event.subtype === 'message_changed' ? event.message : event;
  if (
    !message ||
    message.bot_id !== config.botId ||
    !message.ts ||
    (message.thread_ts != null && message.thread_ts !== message.ts) ||
    !Array.isArray(message.blocks)
  )
    return false;
  const markers = message.blocks.flatMap((block) =>
    typeof block?.block_id === 'string' && block.block_id.startsWith('sre-alert-root:')
      ? [block.block_id]
      : [],
  );
  if (markers.length !== 1) return false;
  const intakeId = MARKER.exec(markers[0]!)?.[1];
  if (!intakeId) return false;
  const intake = await getAlertEpisodeIntake(db, config.tenantId, intakeId);
  if (!intake || intake.channel !== event.channel) return false;
  if (intake.state === 'posted' || intake.state === 'accepted')
    return intake.rootMessageId === message.ts;
  // Slack may echo the root before its post response arrives, or after an ambiguous response.
  return intake.state === 'posting' || intake.state === 'uncertain';
}
