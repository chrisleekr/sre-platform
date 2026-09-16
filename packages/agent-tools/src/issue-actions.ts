import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  activeResponderTx,
  connectorConfigs,
  humanMessageFenceMatchesTx,
  incidents,
  issueActions,
  lockConnectorLifecycle,
  lockIncidentWorkTx,
  withTenant,
  type Db,
  type Tx,
} from '@sre/db';
import {
  issueChangesSchema,
  issueNumber,
  IssueRequestError,
  type IDataSourceConnector,
} from '@sre/connectors';
import type { IssueActionView, IssueDraftRequest, RepositoryIssue } from '@sre/contracts';
import type { ConversationHub } from '@sre/hub';
import { redactInput } from './redact';
import { assertIssueAdmission } from './issue-admission';

export const issueDraftSchema = z
  .object({
    connectorId: z.uuid(),
    repository: z.string().trim().min(1).max(255),
    number: issueNumber.optional(),
    changes: issueChangesSchema,
  })
  .strict();
export interface IssueActionDeps {
  db: Db;
  hub: Pick<ConversationHub, 'appendTxOnce' | 'publishAppendedBestEffort'>;
  resolveConnectors: (tenantId: string) => Promise<IDataSourceConnector[]>;
}
type Row = typeof issueActions.$inferSelect;

/** Scrub issue content before preview, persistence or surface delivery.
 * @param value - Provider data or proposed fields.
 */
export function publicIssueData<T>(value: T): T {
  return redactInput(value) as T;
}

/** Expose only the saved preview and outcome, never configuration or credentials.
 * @param row - Tenant-scoped durable action.
 */
export function issueActionView(row: Row): IssueActionView {
  return {
    id: row.id,
    connectorId: row.connectorId,
    repository: row.repository,
    destination: row.destination,
    ...(row.number !== null ? { number: row.number } : {}),
    changes: row.changes,
    requestedBy: row.requestedBy,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
    before: row.before,
    result: row.result,
    error: row.error,
  };
}

async function authorize(tx: Tx, tenantId: string, incidentId: string, userId: string | null) {
  await lockIncidentWorkTx(tx, tenantId, [incidentId]);
  if (!(await activeResponderTx(tx, tenantId, userId)))
    throw new IssueRequestError('An active, linked workspace member must manage issues.');
  const [incident] = await tx
    .select({ id: incidents.id })
    .from(incidents)
    .where(and(eq(incidents.id, incidentId), isNull(incidents.archivedAt)))
    .limit(1);
  if (!incident) throw new IssueRequestError('The incident is unavailable or archived.');
}

async function connector(deps: IssueActionDeps, tenantId: string, connectorId: string) {
  const source = (await deps.resolveConnectors(tenantId)).find((item) => item.id === connectorId);
  if (!source?.issues || !source.generation)
    throw new IssueRequestError(
      'This connection is unavailable. Save and verify it before managing issues.',
    );
  return source;
}

async function verifyGeneration(tx: Tx, row: Pick<Row, 'connectorId' | 'connectorVersion'>) {
  const [source] = await tx
    .select({ version: connectorConfigs.lifecycleVersion })
    .from(connectorConfigs)
    .where(
      and(
        eq(connectorConfigs.id, row.connectorId),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt),
      ),
    )
    .limit(1);
  if (!source || source.version !== row.connectorVersion)
    throw new IssueRequestError(
      'The connection changed since this preview. Prepare a new issue draft.',
    );
}

/** Persist the exact issue preview without granting a model write authority.
 * @param deps - Durable storage, conversation hub and current connector resolver.
 * @param tenantId - Server-selected workspace.
 * @param incidentId - Current incident.
 * @param userId - Linked requester.
 * @param requestKey - Stable request identity used for replay protection.
 * @param input - Proposed issue target and fields.
 */
export async function prepareIssueAction(
  deps: IssueActionDeps,
  tenantId: string,
  incidentId: string,
  userId: string | null,
  requestKey: string,
  input: IssueDraftRequest,
): Promise<IssueActionView> {
  const draft = issueDraftSchema.parse(publicIssueData(input));
  if (!draft.number && (!draft.changes.title || draft.changes.state !== undefined))
    throw new IssueRequestError('A new issue needs a title and starts open.');
  await withTenant(deps.db, tenantId, (tx) => authorize(tx, tenantId, incidentId, userId));
  const source = await connector(deps, tenantId, draft.connectorId);
  source.issues!.validateChanges(draft.changes);
  const repository = await source.issues!.resolve(draft.repository, true);
  const destination = publicIssueData({
    connectionName: source.name,
    provider: source.type,
    repositoryUrl: await source.issues!.repositoryUrl(repository.fullName),
  });
  const before = draft.number
    ? publicIssueData(await source.issues!.get(repository.fullName, draft.number))
    : null;
  const result = await withTenant(deps.db, tenantId, async (tx) => {
    await authorize(tx, tenantId, incidentId, userId);
    await lockConnectorLifecycle(tx, tenantId, source.id);
    await verifyGeneration(tx, {
      connectorId: source.id,
      connectorVersion: source.generation!.lifecycleVersion,
    });
    const [existing] = await tx
      .select()
      .from(issueActions)
      .where(and(eq(issueActions.incidentId, incidentId), eq(issueActions.requestKey, requestKey)))
      .limit(1);
    if (existing) {
      if (existing.requestedBy !== userId)
        throw new IssueRequestError('This draft belongs to another requester.');
      return { row: existing, message: null };
    }
    const [row] = await tx
      .insert(issueActions)
      .values({
        id: randomUUID(),
        tenantId,
        incidentId,
        connectorId: source.id,
        connectorVersion: source.generation!.lifecycleVersion,
        repository: repository.fullName,
        repositoryId: repository.repositoryId,
        destination,
        number: draft.number ?? null,
        changes: draft.changes,
        before,
        requestKey,
        requestedBy: userId!,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      })
      .returning();
    const { message } = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
      author: 'system',
      kind: 'reply',
      content: `Issue draft for ${repository.fullName}${draft.number ? ` #${draft.number}` : ''}. No external change has been made.\nConnection: ${destination.connectionName} · ${destination.provider}\nDestination: ${destination.repositoryUrl}\n\nProposed changes:\n\n\`\`\`json\n${JSON.stringify(draft.changes, null, 2)}\n\`\`\`\n\nReview in the incident’s Issues panel, or reply \`Confirm issue ${row!.id}\` within 15 minutes. Reply \`Cancel issue ${row!.id}\` to discard it.`,
      originMessageId: `issue-draft:${row!.id}`,
    });
    return { row: row!, message };
  });
  if (result.message) await deps.hub.publishAppendedBestEffort(result.message);
  return issueActionView(result.row);
}

/** Read bounded issue-action history for an incident.
 * @param deps - Tenant-scoped storage.
 * @param tenantId - Current workspace.
 * @param incidentId - Current incident.
 */
export async function listIssueActions(
  deps: Pick<IssueActionDeps, 'db'>,
  tenantId: string,
  incidentId: string,
): Promise<IssueActionView[]> {
  return withTenant(deps.db, tenantId, async (tx) =>
    (
      await tx
        .select()
        .from(issueActions)
        .where(eq(issueActions.incidentId, incidentId))
        .orderBy(desc(issueActions.createdAt))
        .limit(50)
    ).map(issueActionView),
  );
}

/** Consume one confirmed draft before dispatch, never repeat an uncertain provider write.
 * @param deps - Storage, hub and fresh connector resolver.
 * @param tenantId - Current workspace.
 * @param incidentId - Current incident.
 * @param userId - Linked confirming requester.
 * @param id - Exact durable draft identity.
 * @param decision - Confirm or cancel this draft.
 * @param messageFence - Latest human input required for a conversation confirmation.
 */
export async function decideIssueAction(
  deps: IssueActionDeps,
  tenantId: string,
  incidentId: string,
  userId: string | null,
  id: string,
  decision: 'confirm' | 'cancel',
  messageFence?: string,
): Promise<IssueActionView> {
  const claim = await withTenant(deps.db, tenantId, async (tx) => {
    await authorize(tx, tenantId, incidentId, userId);
    const [row] = await tx
      .select()
      .from(issueActions)
      .where(and(eq(issueActions.id, id), eq(issueActions.incidentId, incidentId)))
      .limit(1)
      .for('update');
    if (!row || row.requestedBy !== userId)
      throw new IssueRequestError(
        'Only the requesting member can confirm or cancel this issue draft.',
      );
    if (row.status !== 'draft') return { row, claimed: false, message: null };
    if (
      decision === 'confirm' &&
      messageFence &&
      !(await humanMessageFenceMatchesTx(tx, incidentId, messageFence))
    )
      throw new IssueRequestError(
        'A newer message arrived. Review the saved issue draft and confirm it again if still wanted.',
      );
    const expired = row.expiresAt.getTime() <= Date.now();
    const status = expired || decision === 'cancel' ? 'cancelled' : 'executing';
    const [updated] = await tx
      .update(issueActions)
      .set({ status, ...(expired ? { error: 'This draft expired. Prepare a new preview.' } : {}) })
      .where(eq(issueActions.id, id))
      .returning();
    const receipt =
      status === 'cancelled'
        ? await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
            author: 'system',
            kind: 'reply',
            content: expired
              ? 'The issue draft expired. No external change was made. Prepare a new preview.'
              : 'Issue draft cancelled. No external change was made.',
            originMessageId: `issue-result:${id}`,
          })
        : null;
    return { row: updated!, claimed: status === 'executing', message: receipt?.message ?? null };
  });
  if (claim.message) await deps.hub.publishAppendedBestEffort(claim.message);
  if (!claim.claimed) return issueActionView(claim.row);
  let result: RepositoryIssue | null = null;
  let sent = false;
  try {
    const source = await connector(deps, tenantId, claim.row.connectorId);
    source.issues!.validateChanges(claim.row.changes);
    const prepared = await source.issues!.prepareWrite(claim.row.repository);
    // Keep authority locks through dispatch so revocation cannot commit before the captured write.
    const completed = await withTenant(deps.db, tenantId, async (tx) => {
      await authorize(tx, tenantId, incidentId, userId);
      if (messageFence && !(await humanMessageFenceMatchesTx(tx, incidentId, messageFence)))
        throw new IssueRequestError(
          'A newer message arrived before dispatch. No issue change was made. Prepare a new preview if still wanted.',
        );
      await lockConnectorLifecycle(tx, tenantId, claim.row.connectorId);
      await verifyGeneration(tx, claim.row);
      if (source.generation!.lifecycleVersion !== claim.row.connectorVersion)
        throw new IssueRequestError('The connection changed. Prepare a new preview.');
      if (prepared.repository.repositoryId !== claim.row.repositoryId)
        throw new IssueRequestError(
          'Repository identity changed since this preview. Prepare a new draft.',
        );
      await assertIssueAdmission(
        tx,
        source.type,
        source.id,
        claim.row.repositoryId,
        claim.row.repository,
      );
      if (claim.row.number !== null) {
        const current = publicIssueData(await prepared.get(claim.row.repository, claim.row.number));
        if (!isDeepStrictEqual(current, claim.row.before))
          throw new IssueRequestError(
            'The issue changed since this preview. Read it again and prepare a new draft.',
          );
      }
      sent = true;
      result = publicIssueData(
        claim.row.number === null
          ? await prepared.create(claim.row.repository, claim.row.changes)
          : await prepared.update(claim.row.repository, claim.row.number, claim.row.changes),
      );
      const unapplied = Object.entries(claim.row.changes)
        .filter(([key, value]) => {
          const actual = result![key as keyof RepositoryIssue];
          return !isDeepStrictEqual(
            Array.isArray(value) ? [...value].sort() : value,
            Array.isArray(actual) ? [...actual].sort() : actual,
          );
        })
        .map(([key]) => key);
      const warning = unapplied.length
        ? `The provider returned an issue, but these fields differ from the preview: ${unapplied.join(', ')}. Inspect the result before preparing another change.`
        : null;
      const [row] = await tx
        .update(issueActions)
        .set({ status: warning ? 'unknown' : 'succeeded', result, error: warning })
        .where(eq(issueActions.id, id))
        .returning();
      const { message } = await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
        author: 'system',
        kind: 'reply',
        content: warning
          ? `${warning}\n${result.url}`
          : `${claim.row.number === null ? 'Created' : 'Updated'} issue ${claim.row.repository} #${result.number}: ${result.title}\n${result.url}\nState: ${result.state}.`,
        originMessageId: `issue-result:${id}`,
      });
      return { row: row!, message };
    });
    await deps.hub.publishAppendedBestEffort(completed.message);
    return issueActionView(completed.row);
  } catch (error) {
    const uncertain = error instanceof IssueRequestError ? error.uncertain : sent;
    const message =
      error instanceof IssueRequestError
        ? error.message
        : uncertain
          ? 'The provider outcome is unknown. Inspect the repository before attempting another change.'
          : 'Issue management is unavailable. Check the connection and prepare a new draft.';
    const saved = await withTenant(deps.db, tenantId, async (tx) => {
      const [row] = await tx
        .update(issueActions)
        .set({ status: uncertain ? 'unknown' : 'failed', error: message })
        .where(and(eq(issueActions.id, id), eq(issueActions.status, 'executing')))
        .returning();
      const receipt = row
        ? await deps.hub.appendTxOnce(tx, tenantId, incidentId, {
            author: 'system',
            kind: 'reply',
            content: message,
            originMessageId: `issue-result:${id}`,
          })
        : null;
      return { row, message: receipt?.message ?? null };
    });
    if (saved.message) await deps.hub.publishAppendedBestEffort(saved.message);
    if (!saved.row) throw error;
    return issueActionView(saved.row);
  }
}
