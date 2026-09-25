import {
  alertmanagerEventToken,
  listStatusCakeUptimeTests,
  statusCakeDelivery,
  statusCakeSetupApi,
  syncStatusCakeContactGroups,
  StatusCakeSetupError,
  type StatusCakeSetupResult,
  type StatusCakeUptimeTest,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  connectorEventCredentialKey,
  withTenant,
  type Db,
  type SecretStore,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';

// Longer than any pass StatusCake's rate limits let finish; an expired lease only permits overlap.
const LEASE_TTL_SEC = 30 * 60;

/** Dependencies for StatusCake contact-group setup. */
export interface StatusCakeSetupDeps {
  db: Db;
  secrets: SecretStore;
  /** Cross-replica lease so the dashboard and the background sync never write at the same time. */
  lease?: {
    acquire(name: string, ttlSec: number): Promise<string | null>;
    release(name: string, token: string): Promise<void>;
  };
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Outcome of reading or applying StatusCake setup for one connection. */
export type StatusCakeSetupRun =
  | { status: 'not_found' }
  | { status: 'off' }
  | { status: 'busy' }
  | { status: 'list'; tests: StatusCakeUptimeTest[]; error?: StatusCakeSetupResult['error'] }
  | ({ status: 'synced' } & StatusCakeSetupResult);

/**
 * Lists a StatusCake connection's uptime tests with their setup state, or applies its setup.
 *
 * @remarks A saved `receiverOrigin` marks a managed connection. It outlives turning notifications
 * off until a removal pass finishes, so the background sync retries a failed removal.
 * @param deps - Database, credentials, lease, and transport.
 * @param tenantId - Workspace owning the connection.
 * @param connectorId - StatusCake connection ID.
 * @param apply - Write missing contact groups when true; report only when false.
 * @param background - Skip, without calling StatusCake, a connection the platform does not manage.
 */
export async function runStatusCakeSetup(
  deps: StatusCakeSetupDeps,
  tenantId: string,
  connectorId: string,
  apply: boolean,
  background = false,
): Promise<StatusCakeSetupRun> {
  // Provider calls run after this transaction closes, so no database connection waits on StatusCake.
  const loaded = await withTenant(deps.db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        settings: connectorConfigs.settings,
        webhookKey: connectorConfigs.webhookKey,
        enabled: connectorConfigs.enabled,
      })
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, connectorId),
          eq(connectorConfigs.type, 'statuscake'),
          isNull(connectorConfigs.deletedAt),
        ),
      );
    if (!row) return null;
    const token = await deps.secrets.get(tenantId, connectorCredentialKey(connectorId), tx);
    const secret = alertmanagerEventToken(
      await deps.secrets.get(tenantId, connectorEventCredentialKey(connectorId), tx),
    );
    return { ...row, token, secret };
  });
  if (!loaded?.token) return { status: 'not_found' };
  const delivery = statusCakeDelivery(loaded.settings);
  const managed = typeof (loaded.settings as Record<string, unknown>).receiverOrigin === 'string';
  // A connection configured by hand before managed setup has no receiver origin. Its contact groups
  // were made by the operator, so the background pass leaves them alone.
  if (background && !managed) return { status: 'off' };
  const api = statusCakeSetupApi(loaded.token.trim(), deps.fetch ?? fetch);
  const failed = (error: unknown): StatusCakeSetupRun => {
    if (!(error instanceof StatusCakeSetupError)) throw error;
    return {
      status: 'list',
      tests: [],
      error: { category: error.category, message: error.message },
    };
  };
  if (!loaded.webhookKey || (apply && !loaded.enabled))
    return listStatusCakeUptimeTests(api).then((tests) => ({ status: 'list', tests }), failed);
  const leaseName = `statuscake-setup:${connectorId}`;
  const leaseToken = apply && deps.lease ? await deps.lease.acquire(leaseName, LEASE_TTL_SEC) : '';
  if (leaseToken === null) return { status: 'busy' };
  try {
    const run = await syncStatusCakeContactGroups(api, {
      // Delivery off binds no tests, so applying it removes this connection's contact groups.
      delivery: delivery ?? { mode: 'custom', selected: [], excluded: [] },
      webhookKey: loaded.webhookKey,
      ...(delivery?.receiverOrigin ? { origin: delivery.receiverOrigin } : {}),
      ...(loaded.secret ? { secret: loaded.secret } : {}),
      apply,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }).then((result): StatusCakeSetupRun => ({ status: 'synced', ...result }), failed);
    if (apply && !delivery && managed && run.status === 'synced' && !run.error)
      await withTenant(deps.db, tenantId, (tx) =>
        tx
          .update(connectorConfigs)
          .set({ settings: sql`${connectorConfigs.settings} - 'receiverOrigin'` })
          .where(
            and(
              eq(connectorConfigs.id, connectorId),
              // A save that turned notifications back on meanwhile keeps its origin.
              sql`coalesce(${connectorConfigs.settings}->>'eventTransport', 'none') <> 'direct'`,
            ),
          ),
      );
    return run;
  } finally {
    if (leaseToken && deps.lease) await deps.lease.release(leaseName, leaseToken);
  }
}
