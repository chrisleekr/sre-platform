/**
 * The connected Slack surface.
 *
 * Slack is a surface, not a data source: it is where conversations arrive and where answers are
 * posted. Without it the inbound page has nothing to show but its empty state, so the demo carries
 * a connected workspace, two subscribed channels, and a receipt for every message the platform has
 * seen.
 *
 * The tokens are invented and never leave the encrypted store. Nothing here calls Slack.
 */
import {
  inboundChannels,
  surfaceConfigs,
  surfaceInboundEvents,
  surfaceAppTokenKey,
  surfaceBotTokenKey,
  withTenant,
} from '../../../packages/db/src/index';
import type { DemoSeedDeps } from './demo-environment';

const MINUTE = 60_000;

interface Receipt {
  channel: string;
  eventType: string;
  outcome: string;
  minutesAgo: number;
}

// One row per outcome a reader will meet on the page. Every inbound message gets one of these,
// including the ones the platform decided not to act on.
const RECEIPTS: Receipt[] = [
  {
    channel: 'C-ALERTS-PROD',
    eventType: 'message',
    outcome: 'provider_alert_opened',
    minutesAgo: 22,
  },
  { channel: 'C-ALERTS-PROD', eventType: 'message', outcome: 'belongs_to', minutesAgo: 19 },
  { channel: 'C-ALERTS-PROD', eventType: 'message', outcome: 'resume_enqueued', minutesAgo: 13 },
  {
    channel: 'C-ALERTS-PLATFORM',
    eventType: 'message',
    outcome: 'provider_alert_opened',
    minutesAgo: 8,
  },
  { channel: 'C-ALERTS-PROD', eventType: 'message', outcome: 'not_worthy', minutesAgo: 6 },
  {
    channel: 'C-ALERTS-PROD',
    eventType: 'block_actions',
    outcome: 'interaction_processed',
    minutesAgo: 4,
  },
];

/**
 * Connects Slack for the demo tenant and records what happened to each inbound message.
 *
 * @param deps - Tenant-scoped connections, the credential store, and the time anchor.
 */
export async function seedSlackSurface(deps: DemoSeedDeps): Promise<void> {
  const { now } = deps;
  await deps.secrets.put(deps.tenantId, surfaceBotTokenKey('slack'), 'xoxb-demo-not-a-real-token');
  await deps.secrets.put(deps.tenantId, surfaceAppTokenKey('slack'), 'xapp-demo-not-a-real-token');

  const configId = await withTenant(deps.appDb, deps.tenantId, async (tx) => {
    const [config] = await tx
      .insert(surfaceConfigs)
      .values({
        tenantId: deps.tenantId,
        surface: 'slack',
        botUserId: 'U0DEMOBOT',
        botId: 'B0DEMOBOT',
        teamId: 'T0DEMOTEAM',
        appId: 'A0DEMOAPP',
      })
      .returning({ id: surfaceConfigs.id });
    if (!config) throw new Error('demo seed: the Slack surface was not inserted');

    await tx.insert(inboundChannels).values([
      {
        tenantId: deps.tenantId,
        surface: 'slack',
        channel: 'C-ALERTS-PROD',
        channelName: 'alerts-production',
        enabled: true,
      },
      {
        tenantId: deps.tenantId,
        surface: 'slack',
        channel: 'C-ALERTS-PLATFORM',
        channelName: 'alerts-platform',
        enabled: true,
      },
    ]);
    return config.id;
  });

  // The inbound receipt table is system-scoped: the application role has no grant on it, because
  // the platform writes a receipt before it knows which tenant an envelope belongs to.
  await deps.adminDb.insert(surfaceInboundEvents).values(
    RECEIPTS.map((receipt, index) => {
      const at = new Date(now.getTime() - receipt.minutesAgo * MINUTE);
      return {
        tenantId: deps.tenantId,
        configId,
        surface: 'slack',
        deliveryKey: `demo-envelope-${index}`,
        envelopeType: receipt.eventType === 'block_actions' ? 'interactive' : 'events_api',
        eventType: receipt.eventType,
        channel: receipt.channel,
        // Deliberately outside the incident threads' identifier space. A receipt that names the
        // same message as an incident signal is a terminal decision on that message, and the
        // database refuses the signal that would follow it.
        externalMessageId: `demo-inbound-${index}`,
        state: 'processed' as const,
        outcome: receipt.outcome,
        terminalDisposition: receipt.outcome,
        terminalDispositionAt: at,
        terminalDispositionEventAt: at,
        attemptCount: 1,
        acceptedAt: at,
        completedAt: at,
        updatedAt: at,
      };
    }),
  );
}
