import {
  ACTIVE_STATUSES,
  activeResponderTx,
  clearRecoveryTx,
  incidents,
  incidentMessages,
  incidentRelations,
  lockResponseGroupWorkTx,
  prepareResponseGroupRecoveryTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { HubStore } from './store';
import type { HubMessage } from './contracts';

export interface ResolutionPolicyCommand {
  policy: typeof incidents.$inferSelect.resolutionPolicy;
  reason: string;
  requestId: string;
  expectedVersion: number;
  authorUserId: string | null;
  enqueueRecoveryTx: (
    tx: Tx,
    context: { rootIncidentId: string; lifecycleVersion: number; signalFence: string },
  ) => Promise<string | null>;
}

/** Applies a reasoned, versioned policy command through the canonical conversation. */
export async function changeResolutionPolicy(
  db: Db,
  store: HubStore,
  tenantId: string,
  incidentId: string,
  input: ResolutionPolicyCommand,
): Promise<{ outcome: string; message?: HubMessage; recoveryJobId?: string | null }> {
  return withTenant(db, tenantId, async (tx) => {
    if (!(await activeResponderTx(tx, tenantId, input.authorUserId)))
      return { outcome: 'forbidden' };
    const { rootIncidentId } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
    const [incident] = await tx
      .select()
      .from(incidents)
      .where(eq(incidents.id, incidentId))
      .for('update');
    if (!incident) return { outcome: 'not_found' };
    if (incident.archivedAt) return { outcome: 'archived' };
    const [merged] = await tx
      .select({ id: incidentRelations.id })
      .from(incidentRelations)
      .where(
        and(
          eq(incidentRelations.sourceIncidentId, incidentId),
          eq(incidentRelations.type, 'merged_into'),
          isNull(incidentRelations.supersededAt),
        ),
      )
      .limit(1);
    if (merged) return { outcome: 'merged' };
    if (
      !ACTIVE_STATUSES.includes(incident.status as (typeof ACTIVE_STATUSES)[number]) ||
      (incident.purpose === 'health_check' && input.policy !== 'verified_recovery')
    )
      return { outcome: 'invalid' };
    const key = `resolution-policy:${incidentId}:${input.requestId}`;
    const label =
      input.policy === 'provider_clear' ? 'Provider signals clear' : 'Verified recovery';
    const content = `Resolution policy changed to ${label}. Reason: ${input.reason}`;
    const [prior] = await tx
      .select()
      .from(incidentMessages)
      .where(
        and(eq(incidentMessages.incidentId, incidentId), eq(incidentMessages.originMessageId, key)),
      )
      .limit(1);
    if (prior)
      return {
        outcome:
          prior.content === content &&
          prior.authorUserId === input.authorUserId &&
          prior.lifecycleVersion === incident.lifecycleVersion
            ? 'noop'
            : 'stale',
      };
    if (incident.lifecycleVersion !== input.expectedVersion) return { outcome: 'stale' };
    const version = incident.lifecycleVersion + 1;
    await clearRecoveryTx(tx, tenantId, incidentId);
    if (rootIncidentId !== incidentId) await clearRecoveryTx(tx, tenantId, rootIncidentId);
    await tx
      .update(incidents)
      .set({
        resolutionPolicy: input.policy,
        resolutionBasis: null,
        lifecycleVersion: version,
        updatedAt: sql`now()`,
      })
      .where(eq(incidents.id, incidentId));
    if (rootIncidentId !== incidentId)
      await tx
        .update(incidents)
        .set({
          lifecycleVersion: sql`${incidents.lifecycleVersion} + 1`,
          resolutionBasis: null,
        })
        .where(eq(incidents.id, rootIncidentId));
    const { message } = await store.appendTxOnce(tx, tenantId, incidentId, {
      author: 'human',
      authorUserId: input.authorUserId,
      originSurface: 'dashboard',
      originMessageId: key,
      kind: 'status',
      content,
      lifecycleVersion: version,
    });
    const candidate = await prepareResponseGroupRecoveryTx(tx, tenantId, incidentId);
    const recoveryJobId = candidate ? await input.enqueueRecoveryTx(tx, candidate) : undefined;
    return { outcome: 'applied', message, recoveryJobId };
  });
}
