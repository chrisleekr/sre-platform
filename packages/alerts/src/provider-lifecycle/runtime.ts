import type { ConversationHub } from '@sre/hub';
import type { RouteDeps } from '../route-to-incident';

/**
 * Builds native routing with the same atomic opener and canonical conversation as direct delivery.
 * @param input - Tenant database, queue, reservation cache, and hub dependencies.
 */
export function nativeLifecycleRoute(
  input: Pick<RouteDeps, 'appDb' | 'redis' | 'queue'> & { hub: ConversationHub },
): RouteDeps {
  return {
    appDb: input.appDb,
    redis: input.redis,
    queue: input.queue,
    appendOpenerTx: async (tx, tenantId, incidentId, opener, observed) => {
      const opened = await input.hub.appendTxOnce(tx, tenantId, incidentId, {
        ...opener,
        ...(observed
          ? {
              kind: 'signal',
              signalId: observed.id,
              signalState: observed.state,
              signalEventType: observed.eventType,
            }
          : {}),
      });
      const lifecycle = await input.hub.appendTxOnce(tx, tenantId, incidentId, {
        author: 'system',
        kind: 'lifecycle',
        content: 'Incident open: provider alert accepted for investigation.',
        lifecycleFrom: null,
        lifecycleTo: 'open',
        lifecycleVersion: 0,
        transitionKey: `incident-open:${incidentId}:0`,
      });
      return {
        incidentId,
        afterCommit: async () => {
          await input.hub.publishAppended(opened.message);
          await input.hub.publishAppended(lifecycle.message);
        },
      };
    },
  };
}
