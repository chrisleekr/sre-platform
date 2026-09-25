import { connectorConfigs, withTenant } from '@sre/db';
import { eq, sql } from 'drizzle-orm';

import type { AlertmanagerWebhookDeps } from '../alertmanager-webhook';

/** Records one Alertmanager delivery attempt and its connector health outcome. */
export async function eventHealth(
  deps: AlertmanagerWebhookDeps,
  tenantId: string,
  connectorId: string,
  attemptedAt: Date,
  failureCategory?: string,
  deferred = false,
  // An acknowledged notice proves delivery works but resolves nothing a prior failure reported.
  acknowledgedOnly = false,
): Promise<void> {
  await withTenant(deps.appDb, tenantId, (tx) =>
    tx
      .update(connectorConfigs)
      .set({
        eventAttemptedAt: attemptedAt,
        ...(failureCategory
          ? { eventFailureCategory: failureCategory }
          : deferred
            ? {}
            : {
                eventSucceededAt: attemptedAt,
                eventCount: sql`${connectorConfigs.eventCount} + 1`,
                ...(acknowledgedOnly ? {} : { eventFailureCategory: null }),
              }),
        updatedAt: sql`now()`,
      })
      .where(eq(connectorConfigs.id, connectorId)),
  );
}
