import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import {
  gitlabProjects,
  markGitLabProjectRemoved,
  recordGitLabEvent,
  upsertGitLabProject,
  type Tx,
} from '@sre/db';
import type { NormalizedSnapshot } from '@sre/connectors';
import { gitLabRevisionKey } from '@sre/connectors';

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Save allowlisted polling evidence inside the connector generation/cursor transaction.
 * @param tx - Tenant transaction holding the connector row lock.
 * @param tenantId - Workspace owning every observation.
 * @param connectorId - Connector whose cursor has passed its compare-and-swap check.
 * @param snapshots - Bounded read-only GitLab polling batch.
 */
export async function persistGitLabPoll(
  tx: Tx,
  tenantId: string,
  connectorId: string,
  snapshots: NormalizedSnapshot[],
): Promise<void> {
  for (const snapshot of snapshots) {
    if (snapshot.source !== 'gitlab' || snapshot.tenantId !== tenantId)
      throw new Error('GitLab poll tenant/source mismatch');
    const value = snapshot.metadata;
    if (typeof value.kind !== 'string' || !value.kind.startsWith('gitlab-')) continue;
    const projectId = text(value.projectId);
    if (!projectId) throw new Error('GitLab poll missing project identity');
    if (value.kind === 'gitlab-project') {
      const groupId = text(value.groupId),
        name = text(value.name),
        fullPath = text(value.fullPath),
        webUrl = text(value.webUrl);
      if (!groupId || !name || !fullPath || !webUrl)
        throw new Error('GitLab poll invalid catalog item');
      await upsertGitLabProject(
        tx,
        tenantId,
        connectorId,
        {
          groupId,
          projectId,
          name,
          fullPath,
          webUrl,
          archived: value.archived === true,
          defaultBranch: text(value.defaultBranch),
          visibility: text(value.visibility),
        },
        snapshot.observedAt,
      );
    }
    if (value.kind === 'gitlab-poll-state') {
      if (value.removed === true)
        await markGitLabProjectRemoved(tx, tenantId, connectorId, projectId);
      await tx
        .update(gitlabProjects)
        .set({
          pollCursor: object(value.cursor),
          pollAttemptedAt: snapshot.observedAt,
          ...(value.failureCategory == null ? { pollSucceededAt: snapshot.observedAt } : {}),
          pollFailureCategory: text(value.failureCategory) ?? null,
          pollActive: value.removed !== true && value.active === true,
        })
        .where(
          and(eq(gitlabProjects.connectorId, connectorId), eq(gitlabProjects.projectId, projectId)),
        );
    }
    if (value.kind === 'gitlab-event') {
      const eventType = text(value.eventType),
        repo = text(value.repo),
        details = object(value.details);
      if (!eventType || !repo || !text(details.id)) throw new Error('GitLab poll invalid event');
      // The observation time is excluded so an unchanged API result is idempotent across polls.
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ projectId, eventType, details }))
        .digest('hex');
      const at = text(details.at);
      await recordGitLabEvent(tx, tenantId, connectorId, {
        deliveryId: `poll:${fingerprint}`,
        observationKey: ['pipeline', 'job', 'deployment'].includes(eventType)
          ? gitLabRevisionKey(
              eventType,
              projectId,
              text(details.id),
              text(details.status),
              text(details.revisionAt),
            )
          : undefined,
        eventType,
        projectId,
        projectFullPath: repo,
        action: text(details.status),
        ref: text(details.ref),
        sha: text(details.sha),
        summary: {
          ...details,
          provenance: 'polling',
          observedAt: snapshot.observedAt.toISOString(),
        },
        occurredAt: at && Number.isFinite(Date.parse(at)) ? new Date(at) : snapshot.observedAt,
      });
    }
  }
}
