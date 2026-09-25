import { connectorConfigs, type Tx } from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';

/** Holds the connector generation through the transaction that consumes its verified evidence. */
export async function assertAlertConnectorGeneration(
  tx: Tx,
  connector: { id: string; tenantId: string; lifecycleVersion?: number },
): Promise<void> {
  if (connector.lifecycleVersion === undefined) return;
  const [current] = await tx
    .select({ id: connectorConfigs.id })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, connector.id),
        eq(connectorConfigs.tenantId, connector.tenantId),
        eq(connectorConfigs.lifecycleVersion, connector.lifecycleVersion),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
      ),
    )
    .for('share')
    .limit(1);
  if (!current) throw new Error('connector generation changed before lifecycle persistence');
}
