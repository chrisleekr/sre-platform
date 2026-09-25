import { randomUUID } from 'node:crypto';
import {
  alertEpisodeIntakes,
  connectorConfigs,
  withTenant,
  type AlertIntakeState,
  type Db,
} from '@sre/db';

export const nativeBlocks = (id: string) => [
  {
    type: 'section',
    block_id: `sre-alert-root:${id}`,
    text: { type: 'plain_text', text: '[FIRING] Checkout error rate is high' },
  },
];

export async function seedNativeOpener(
  db: Db,
  tenantId: string,
  state: AlertIntakeState,
  channel: string,
  rootMessageId: string,
  accepted?: { incidentId: string; bindingId: string },
) {
  return withTenant(db, tenantId, async (tx) => {
    const [connector] = await tx
      .insert(connectorConfigs)
      .values({
        tenantId,
        name: `Native echo fixture ${randomUUID()}`,
        type: 'prometheus',
        settings: {},
      })
      .returning();
    const [intake] = await tx
      .insert(alertEpisodeIntakes)
      .values({
        tenantId,
        dataSourceId: connector!.id,
        providerFingerprint: randomUUID(),
        startsAt: new Date('2026-09-01T00:00:00Z'),
        materialHash: 'native-opener-fixture',
        channel,
        state,
        rootMessageId: state === 'posted' || state === 'accepted' ? rootMessageId : null,
        ...accepted,
        observation: {
          status: 'firing',
          groupKey: 'checkout',
          alertName: 'CheckoutErrors',
          labels: {},
          annotations: {},
          endsAt: null,
          generatorUrl: null,
          externalUrl: null,
        },
      })
      .returning();
    return intake!;
  });
}
