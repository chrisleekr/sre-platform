import { sql } from 'drizzle-orm';
import type { Tx } from './rls';

/** Serialize connector credential changes with confirmed external writes.
 * @param tx - Tenant-scoped transaction.
 * @param tenantId - Workspace owning the connector.
 * @param connectorId - Connector identity.
 */
export async function lockConnectorLifecycle(
  tx: Tx,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${connectorId}))`,
  );
}
