import { and, desc, eq, inArray, isNull, like, lt, lte, ne } from 'drizzle-orm';
import type { Db } from '../client';
import { withTenant, type Executor, type Tx } from '../rls';
import { incidentSignals, incidents } from '../schema';

import { applySignalObservationTx } from './observation';
import type { SignalApplyResult, SignalObservation } from './recovery';

function visibleIncidentIds(tx: Tx) {
  return tx.select({ id: incidents.id }).from(incidents).where(isNull(incidents.archivedAt));
}

/**
 * Finds one provider alert episode by its source-owned identity.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the signal.
 * @param dataSourceId - Connector instance that observed the signal.
 * @param providerFingerprint - Provider-owned alert fingerprint.
 * @param startsAt - Provider episode start timestamp.
 */
export async function getSignalByProviderEpisode(
  db: Db,
  tenantId: string,
  dataSourceId: string,
  providerFingerprint: string,
  startsAt: Date,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.dataSourceId, dataSourceId),
          eq(incidentSignals.providerFingerprint, providerFingerprint),
          eq(incidentSignals.startsAt, startsAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Most recent older episode with the same provider fingerprint, used only as recurrence history.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param dataSourceId - Data source targeted by the operation.
 * @param providerFingerprint - Provider-owned alert fingerprint.
 * @param startsAt - Provider episode start timestamp.
 */
export async function getPreviousProviderEpisode(
  db: Db,
  tenantId: string,
  dataSourceId: string,
  providerFingerprint: string,
  startsAt: Date,
) {
  return withTenant(db, tenantId, (tx) =>
    getPreviousProviderEpisodeTx(tx, dataSourceId, providerFingerprint, startsAt),
  );
}

/**
 * Returns previous provider episode tx.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param dataSourceId - Data source targeted by the operation.
 * @param providerFingerprint - Provider-owned alert fingerprint.
 * @param startsAt - Provider episode start timestamp.
 */
export async function getPreviousProviderEpisodeTx(
  tx: Tx,
  dataSourceId: string,
  providerFingerprint: string,
  startsAt: Date,
) {
  const rows = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.dataSourceId, dataSourceId),
        eq(incidentSignals.providerFingerprint, providerFingerprint),
        lt(incidentSignals.startsAt, startsAt),
        inArray(incidentSignals.incidentId, visibleIncidentIds(tx)),
      ),
    )
    .orderBy(desc(incidentSignals.startsAt), desc(incidentSignals.id))
    .limit(1);
  return rows[0];
}

/**
 * Finds the most recent older episode from the same stable monitor scope.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param dataSourceId - Connector instance that emitted the alert.
 * @param monitorKey - Stable provider-neutral rule scope.
 * @param startsAt - Provider episode start timestamp.
 * @param signalId - Current episode excluded from the recurrence lookup.
 */
export async function getPreviousMonitorEpisodeTx(
  tx: Tx,
  dataSourceId: string,
  monitorKey: string,
  startsAt: Date,
  signalId: string,
) {
  const rows = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.dataSourceId, dataSourceId),
        eq(incidentSignals.monitorKey, monitorKey),
        lte(incidentSignals.startsAt, startsAt),
        ne(incidentSignals.id, signalId),
        inArray(incidentSignals.incidentId, visibleIncidentIds(tx)),
      ),
    )
    .orderBy(
      desc(incidentSignals.startsAt),
      desc(incidentSignals.firstSeenAt),
      desc(incidentSignals.id),
    )
    .limit(1);
  return rows[0];
}

/**
 * Finds the prior Slack episode from one authenticated producer and stable monitor scope.
 *
 * @param tx - Existing transaction carrying tenant scope.
 * @param channel - Slack channel containing the episode.
 * @param producerId - Authenticated Slack producer identity.
 * @param monitorKey - Stable provider-neutral monitor scope.
 * @param signalId - Current signal excluded from history.
 */
export async function getPreviousSlackMonitorEpisodeTx(
  tx: Tx,
  channel: string,
  producerId: string,
  monitorKey: string,
  signalId: string,
) {
  const rows = await tx
    .select()
    .from(incidentSignals)
    .where(
      and(
        eq(incidentSignals.surface, 'slack'),
        eq(incidentSignals.channel, channel),
        eq(incidentSignals.monitorKey, monitorKey),
        like(incidentSignals.lastEventKey, `%:producer:${producerId}`),
        ne(incidentSignals.id, signalId),
        inArray(incidentSignals.incidentId, visibleIncidentIds(tx)),
      ),
    )
    .orderBy(desc(incidentSignals.firstSeenAt), desc(incidentSignals.id))
    .limit(1);
  return rows[0];
}

/**
 * Mark the exact normalized episode state whose investigation completed.
 *
 * @param tx - Existing transaction that already carries tenant scope.
 * @param signalId - Incident signal targeted by the operation.
 * @param materialHash - Hash of the signal material already investigated.
 * @param signalVersion - Exact signal version assessed, when carried by the durable job.
 */
export async function markSignalMaterialInvestigatedTx(
  tx: Tx,
  signalId: string,
  materialHash: string,
  signalVersion?: number,
): Promise<boolean> {
  const rows = await tx
    .update(incidentSignals)
    .set({
      lastInvestigatedMaterialHash: materialHash,
      lastInvestigatedVersion: incidentSignals.version,
    })
    .where(
      and(
        eq(incidentSignals.id, signalId),
        eq(incidentSignals.materialHash, materialHash),
        signalVersion === undefined ? undefined : eq(incidentSignals.version, signalVersion),
      ),
    )
    .returning({ id: incidentSignals.id });
  return rows.length === 1;
}

/**
 * Mark the exact normalized episode state whose investigation completed.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param signalId - Incident signal targeted by the operation.
 * @param materialHash - Hash of the signal material already investigated.
 * @param signalVersion - Exact signal version assessed, when carried by the durable job.
 */
export async function markSignalMaterialInvestigated(
  db: Db,
  tenantId: string,
  signalId: string,
  materialHash: string,
  signalVersion?: number,
): Promise<boolean> {
  return withTenant(db, tenantId, (tx) =>
    markSignalMaterialInvestigatedTx(tx, signalId, materialHash, signalVersion),
  );
}

/**
 * Applies signal observation.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function applySignalObservation(
  exec: Executor,
  tenantId: string,
  input: SignalObservation,
): Promise<SignalApplyResult> {
  return withTenant(exec, tenantId, (tx) => applySignalObservationTx(tx, tenantId, input));
}

/**
 * Returns signal by external.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param channel - Surface channel targeted by the operation.
 * @param externalMessageId - external message id targeted by the operation.
 */
export async function getSignalByExternal(
  db: Executor,
  tenantId: string,
  surface: string,
  channel: string,
  externalMessageId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.surface, surface),
          eq(incidentSignals.channel, channel),
          eq(incidentSignals.externalMessageId, externalMessageId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Durable members of one grouped surface root. The root prefix is platform-owned (`<message>#`), so edits remain addressable after the transient intake reservation expires.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param channel - Surface channel targeted by the operation.
 * @param rootExternalMessageId - Root provider message used to find related signals.
 */
export async function listSignalsByExternalRoot(
  db: Executor,
  tenantId: string,
  surface: string,
  channel: string,
  rootExternalMessageId: string,
) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.surface, surface),
          eq(incidentSignals.channel, channel),
          like(incidentSignals.externalMessageId, `${rootExternalMessageId}#%`),
        ),
      )
      .orderBy(incidentSignals.externalMessageId),
  );
}

/**
 * Finds active Slack episodes for stable monitor identities from one authenticated producer.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant that owns the signals.
 * @param channel - Slack channel containing the observations.
 * @param producerId - Authenticated Slack producer identity.
 * @param monitorKeys - Stable monitor identities to match.
 */
export async function listActiveSlackSignalsByMonitorKeys(
  db: Executor,
  tenantId: string,
  channel: string,
  producerId: string,
  monitorKeys: string[],
) {
  const keys = [...new Set(monitorKeys.filter(Boolean))].slice(0, 100);
  if (keys.length === 0) return [];
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(incidentSignals)
      .where(
        and(
          eq(incidentSignals.surface, 'slack'),
          eq(incidentSignals.channel, channel),
          eq(incidentSignals.state, 'firing'),
          inArray(incidentSignals.monitorKey, keys),
          like(incidentSignals.lastEventKey, `%:producer:${producerId}`),
          inArray(incidentSignals.incidentId, visibleIncidentIds(tx)),
        ),
      )
      .orderBy(desc(incidentSignals.lastSeenAt), desc(incidentSignals.id)),
  );
}

/**
 * Lists incident signals.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param incidentId - Incident targeted by the operation.
 */
export async function listIncidentSignals(db: Db, tenantId: string, incidentId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(incidentSignals)
      .where(eq(incidentSignals.incidentId, incidentId))
      .orderBy(incidentSignals.firstSeenAt, incidentSignals.id),
  );
}

/**
 * Firing/unknown alerts with incident context for a separate provider resolution to correlate against.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 */
export async function listUnresolvedSignals(db: Db, tenantId: string) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: incidentSignals.id,
        incidentId: incidentSignals.incidentId,
        externalMessageId: incidentSignals.externalMessageId,
        channel: incidentSignals.channel,
        summary: incidentSignals.summary,
        state: incidentSignals.state,
        lastEventKey: incidentSignals.lastEventKey,
        service: incidents.service,
        title: incidents.title,
        severity: incidents.severity,
        alertName: incidentSignals.alertName,
        providerGroupKey: incidentSignals.providerGroupKey,
      })
      .from(incidentSignals)
      .innerJoin(incidents, eq(incidents.id, incidentSignals.incidentId))
      .where(and(ne(incidentSignals.state, 'resolved'), isNull(incidents.archivedAt)))
      .orderBy(incidentSignals.lastSeenAt),
  );
}

/**
 * Reads one durable recovery target by ID regardless of its current state.
 * @param db - Tenant-scoped database.
 * @param tenantId - Owning tenant.
 * @param signalId - Durable signal identifier.
 */
export async function getSignalResolutionCandidate(db: Db, tenantId: string, signalId: string) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: incidentSignals.id,
        incidentId: incidentSignals.incidentId,
        externalMessageId: incidentSignals.externalMessageId,
        channel: incidentSignals.channel,
        summary: incidentSignals.summary,
        state: incidentSignals.state,
        lastEventKey: incidentSignals.lastEventKey,
        service: incidents.service,
        title: incidents.title,
        severity: incidents.severity,
        alertName: incidentSignals.alertName,
        providerGroupKey: incidentSignals.providerGroupKey,
      })
      .from(incidentSignals)
      .innerJoin(incidents, eq(incidents.id, incidentSignals.incidentId))
      .where(eq(incidentSignals.id, signalId))
      .limit(1);
    return rows[0] ?? null;
  });
}
