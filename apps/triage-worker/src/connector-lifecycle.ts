import { reconcileConnectorLifecycle, scrubSecrets } from '@sre/agent-tools';
import { nativeLifecycleRoute, processAlert, type NativeLifecycleDeps } from '@sre/alerts';
import { statusCakeMonitorBound, type IDataSourceConnector } from '@sre/connectors';
import {
  connectorConfigs,
  surfaceBotTokenKey,
  withTenant,
  type Db,
  type SecretStore,
} from '@sre/db';
import type { ConversationHub } from '@sre/hub';
import { NonRetryableError, RetryableError, makeSnapshotCache, type Queue } from '@sre/queue';
import { SlackApiError, slackChatPostAlertRoot, type FetchLike } from '@sre/surfaces';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { makeRedisWindowGuard } from './poller';
import { makeStatusCakeSetupSync, statusCakeSetupLease } from './statuscake-setup-sync';

/** Replays a durable authenticated wakeup using current connector credentials and exact provider evidence. */
export async function ingestStatusCakeWakeup(
  deps: {
    db: Db;
    hub: ConversationHub;
    queue: Queue;
    redis: Redis;
    secrets: SecretStore;
    postAlertRoot?: NativeLifecycleDeps['postAlertRoot'];
  },
  tenantId: string,
  connector: IDataSourceConnector,
  // lifecycleVersion is the generation at receipt. Queued payloads keep it, but it is not a fence.
  wakeup: { monitorId: string; observedAt: string; lifecycleVersion: number },
): Promise<void> {
  if (
    connector.type !== 'statuscake' ||
    !connector.alertLifecycle?.readEpisode ||
    !connector.generation
  )
    return;
  // The wakeup is the only copy of its notification and only means "read this monitor now". A
  // binding, or a save already re-verified, bumps the version after receipt; the current row's
  // transport and monitor membership below still fence it, so it is read under the current
  // generation. A save leaves the connector disabled until retested, and that drops it below.
  const generation = connector.generation.lifecycleVersion;
  const [row] = await withTenant(deps.db, tenantId, (tx) =>
    tx
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, connector.id),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      ),
  );
  if (!row) return;
  // A bump committed after this job resolved its connector. Redeliver so it reads the new
  // generation; this shares the job's retry budget.
  if (row.lifecycleVersion !== generation)
    throw new RetryableError('connector generation advanced before wakeup ingest');
  if (!statusCakeMonitorBound(row.settings, wakeup.monitorId)) return;
  // The webhook only persists the wakeup, so delivery health is recorded here once it is verified.
  const recordOutcome = (failureCategory: string | null) =>
    withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(connectorConfigs)
        .set({
          eventAttemptedAt: sql`now()`,
          eventFailureCategory: failureCategory,
          ...(failureCategory === null
            ? { eventSucceededAt: sql`now()`, eventCount: sql`${connectorConfigs.eventCount} + 1` }
            : {}),
        })
        .where(
          and(
            eq(connectorConfigs.id, connector.id),
            eq(connectorConfigs.lifecycleVersion, generation),
          ),
        ),
    );
  const observedAt = new Date(wakeup.observedAt);
  if (!Number.isFinite(observedAt.getTime()))
    throw new Error('invalid retained provider lookup time');
  const result = await connector.alertLifecycle.readEpisode({
    monitorId: wakeup.monitorId,
    family: 'uptime',
    observedAt,
  });
  if (result.status !== 'verified') {
    await recordOutcome(result.reason);
    throw new RetryableError(`provider lifecycle verification unavailable: ${result.reason}`);
  }
  for (const observation of result.observations) {
    let outcome: Awaited<ReturnType<typeof processAlert>>;
    try {
      outcome = await processAlert(
        {
          appDb: deps.db,
          hub: deps.hub,
          route: nativeLifecycleRoute({
            appDb: deps.db,
            redis: deps.redis,
            queue: deps.queue,
            hub: deps.hub,
          }),
          postAlertRoot:
            deps.postAlertRoot ??
            (async (currentTenantId, channel, text, intakeId) => {
              const token = await deps.secrets.get(currentTenantId, surfaceBotTokenKey('slack'));
              if (!token)
                throw new SlackApiError('rejected', 'not_connected', 'Slack is not connected');
              return slackChatPostAlertRoot(
                globalThis.fetch as unknown as FetchLike,
                token,
                channel,
                text,
                intakeId,
              );
            }),
        },
        row,
        `statuscake:uptime:${wakeup.monitorId}`,
        null,
        // The test name is tenant-authored text that reaches the Slack root, signal and disposition.
        { ...observation, alertName: scrubSecrets(observation.alertName) },
        new Date(),
      );
    } catch (error) {
      const uncertain = error instanceof SlackApiError && error.certainty === 'uncertain';
      await recordOutcome(uncertain ? 'delivery_uncertain' : 'delivery_retry_pending');
      if (uncertain)
        throw new NonRetryableError(
          'Slack delivery is uncertain; inspect the existing provider intake and Slack root before replaying.',
        );
      throw new RetryableError('Provider episode delivery must be retried.');
    }
    if (outcome !== 'accepted') {
      const reason =
        outcome === 'unsubscribed'
          ? 'alert_channel_not_subscribed'
          : outcome === 'retry'
            ? 'delivery_retry_pending'
            : 'delivery_uncertain';
      await recordOutcome(reason);
      if (outcome === 'retry')
        throw new RetryableError('Provider episode delivery is still in progress.');
      throw new NonRetryableError(
        outcome === 'unsubscribed'
          ? 'Subscribe the configured Slack alert channel, then replay the retained provider wakeup.'
          : 'Slack delivery is uncertain; inspect the existing provider intake and Slack root before replaying.',
      );
    }
  }
  await recordOutcome(null);
}

/** Connects existing poll jobs to native lifecycle intake, reconciliation, and StatusCake setup. */
export function connectorLifecycleHandlers(deps: Parameters<typeof ingestStatusCakeWakeup>[0]) {
  return {
    syncStatusCakeSetup: makeStatusCakeSetupSync({
      db: deps.db,
      secrets: deps.secrets,
      lease: statusCakeSetupLease(makeSnapshotCache(deps.redis)),
      guardFor: (connectorId) =>
        makeRedisWindowGuard(deps.redis, `statuscake:setup:${connectorId}`),
    }),
    ingestLifecycle: (
      tenantId: string,
      connector: IDataSourceConnector,
      wakeup: Parameters<typeof ingestStatusCakeWakeup>[3],
    ) => ingestStatusCakeWakeup(deps, tenantId, connector, wakeup),
    reconcileLifecycle: (tenantId: string, connector: IDataSourceConnector) =>
      reconcileConnectorLifecycle({ ...deps, tenantId, connector }),
  };
}
