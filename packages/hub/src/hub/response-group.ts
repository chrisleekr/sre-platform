import {
  ACTIVE_STATUSES,
  approvals,
  incidents,
  listResponseGroupSignalsTx,
  lockResponseGroupWorkTx,
  transitionIncidentTx,
  type Tx,
} from '@sre/db';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { HubMessage } from './contracts';
import type { HubStore } from './store';

/** Resolves a root and every active causal symptom while their group locks are held. */
export async function appendResolvedResponseGroupTx(
  store: HubStore,
  tx: Tx,
  tenantId: string,
  rootIncidentId: string,
  responseGroupIds: string[],
  expectedRootVersion: number,
  rootContent: string,
  transitionKey: string,
): Promise<HubMessage[]> {
  const messages: HubMessage[] = [];
  const rootTransition = await transitionIncidentTx(tx, rootIncidentId, 'resolved', {
    expectedVersion: expectedRootVersion,
  });
  if (rootTransition.outcome !== 'applied') return messages;
  messages.push(
    await store.appendTx(tx, tenantId, rootIncidentId, {
      author: 'system',
      kind: 'lifecycle',
      content: rootContent,
      originSurface: 'automation',
      lifecycleFrom: rootTransition.from,
      lifecycleTo: rootTransition.to,
      lifecycleVersion: rootTransition.version!,
      transitionKey,
    }),
  );
  for (const childIncidentId of responseGroupIds.filter((id) => id !== rootIncidentId)) {
    const childRows = await tx
      .select({ status: incidents.status })
      .from(incidents)
      .where(eq(incidents.id, childIncidentId))
      .limit(1);
    const child = childRows[0];
    if (!child || !ACTIVE_STATUSES.includes(child.status as (typeof ACTIVE_STATUSES)[number]))
      continue;
    const childTransition = await transitionIncidentTx(tx, childIncidentId, 'resolved');
    if (childTransition.outcome !== 'applied') continue;
    messages.push(
      await store.appendTx(tx, tenantId, childIncidentId, {
        author: 'system',
        kind: 'lifecycle',
        content: 'Incident resolved: The causal response group recovered.',
        originSurface: 'automation',
        lifecycleFrom: childTransition.from,
        lifecycleTo: childTransition.to,
        lifecycleVersion: childTransition.version!,
        transitionKey: `${transitionKey}:${childIncidentId}`,
      }),
    );
  }
  return messages;
}

/** Completes a verified response group after its final pending approval is decided. */
export async function completeVerifiedRecoveryAfterApprovalTx(
  store: HubStore,
  tx: Tx,
  tenantId: string,
  incidentId: string,
  approvalId: string,
): Promise<HubMessage[]> {
  const { rootIncidentId, incidentIds } = await lockResponseGroupWorkTx(tx, tenantId, incidentId);
  const locked = await tx
    .select({
      id: incidents.id,
      status: incidents.status,
      lifecycleVersion: incidents.lifecycleVersion,
      recoveryState: incidents.recoveryState,
      archivedAt: incidents.archivedAt,
    })
    .from(incidents)
    .where(inArray(incidents.id, incidentIds))
    .orderBy(incidents.id)
    .for('update');
  const root = locked.find((row) => row.id === rootIncidentId);
  if (
    !root ||
    root.archivedAt ||
    !ACTIVE_STATUSES.includes(root.status as (typeof ACTIVE_STATUSES)[number]) ||
    root.recoveryState !== 'verified'
  )
    return [];
  const pending = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(inArray(approvals.incidentId, incidentIds), isNull(approvals.decision)))
    .limit(1);
  if (pending[0]) return [];
  const signals = await listResponseGroupSignalsTx(tx, tenantId, rootIncidentId);
  if (signals.length === 0 || signals.some((signal) => signal.state !== 'resolved')) return [];
  return appendResolvedResponseGroupTx(
    store,
    tx,
    tenantId,
    rootIncidentId,
    incidentIds,
    root.lifecycleVersion,
    'Incident resolved: provider signals are clear and verified recovery was waiting on this approval.',
    `approval-recovery:${rootIncidentId}:${approvalId}`,
  );
}
