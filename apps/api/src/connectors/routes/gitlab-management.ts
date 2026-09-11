import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { gitLabAccessToken } from '@sre/connectors';
import { GITLAB_HOOK_POLICY_VERSION } from '@sre/contracts';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitlabHookAuthorizations,
  gitlabManagedHooks,
  gitlabProjects,
  gitLabManagementCredentialKey,
  withTenant,
} from '@sre/db';
import type { TenantAuthVariables } from '../../auth';
import { connectorInstanceId, requestObject } from '../helpers';
import type { ConnectorRouteContext } from './context';
import { gitLabManagementReview } from './gitlab-management-review';

/** Administrator-only opt-in and revocation; these routes never call GitLab or return saved tokens. */
export function registerGitLabManagementRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  { deps }: ConnectorRouteContext,
): void {
  r.get('/gitlab/:id/management', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = connectorInstanceId(c.req.param('id'));
    if (!id) return c.json({ error: 'invalid data source ID' }, 400);
    const result = await withTenant(deps.db, c.get('tenant').tenantId, async (tx) => {
      const [connection] = await tx
        .select()
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, id),
            eq(connectorConfigs.type, 'gitlab'),
            isNull(connectorConfigs.deletedAt),
          ),
        );
      if (!connection) return null;
      const [authorization] = await tx
        .select()
        .from(gitlabHookAuthorizations)
        .where(eq(gitlabHookAuthorizations.connectorId, id))
        .orderBy(
          sql`(${gitlabHookAuthorizations.revokedAt} is null) desc`,
          desc(gitlabHookAuthorizations.approvedAt),
        )
        .limit(1);
      const authorized = Boolean(
        authorization &&
        !authorization.revokedAt &&
        connection.enabled &&
        requestObject(connection.settings)?.eventStrategy === 'managed_projects' &&
        authorization.lifecycleVersion === connection.lifecycleVersion &&
        authorization.policyVersion === GITLAB_HOOK_POLICY_VERSION,
      );
      const activeAuthorizationId = authorized ? authorization!.id : null;
      const [counts] = await tx
        .select({
          total: sql<number>`count(*)::int`,
          covered: sql<number>`count(*) filter (where ${gitlabManagedHooks.failureCategory} is null and ${gitlabManagedHooks.appliedAuthorizationId} = ${activeAuthorizationId})::int`,
          missing: sql<number>`count(*) filter (where ${gitlabManagedHooks.failureCategory} in ('hook_missing', 'creation_pending'))::int`,
          failed: sql<number>`count(*) filter (where ${gitlabManagedHooks.failureCategory} is not null and ${gitlabManagedHooks.failureCategory} not in ('creation_pending', 'verification_pending', 'retry_authorized'))::int`,
          pending: sql<number>`count(*) filter (where ${gitlabManagedHooks.hookId} is null or ${gitlabManagedHooks.appliedAuthorizationId} is distinct from ${authorization?.id ?? null})::int`,
        })
        .from(gitlabManagedHooks)
        .where(and(eq(gitlabManagedHooks.connectorId, id), eq(gitlabManagedHooks.removed, false)));
      const projects = await tx
        .select({
          project: gitlabManagedHooks.projectPath,
          hookId: gitlabManagedHooks.hookId,
          failureCategory: gitlabManagedHooks.failureCategory,
          lastCheckedAt: gitlabManagedHooks.attemptedAt,
        })
        .from(gitlabManagedHooks)
        .where(eq(gitlabManagedHooks.connectorId, id))
        .orderBy(
          sql`(${gitlabManagedHooks.failureCategory} is not null) desc`,
          sql`${gitlabManagedHooks.attemptedAt} asc nulls first`,
        )
        .limit(20);
      return {
        authorized,
        approvedAt: authorization?.approvedAt ?? null,
        catalogCheckedAt: authorization?.catalogCheckedAt ?? null,
        failureCategory: authorization?.failureCategory ?? null,
        counts,
        projects,
      };
    });
    return result ? c.json(result) : c.json({ error: 'data source not found' }, 404);
  });
  for (const action of ['preview', 'authorize', 'revoke'] as const) {
    r.post(`/gitlab/:id/management/${action}`, async (c) => {
      c.header('Cache-Control', 'no-store');
      const tenant = c.get('tenant');
      if (!['owner', 'admin'].includes(tenant.role) || tenant.impersonation)
        return c.json(
          { error: 'A workspace owner or administrator must authorize webhook management.' },
          403,
        );
      const id = connectorInstanceId(c.req.param('id'));
      if (!id) return c.json({ error: 'invalid data source ID' }, 400);
      const body = requestObject(await c.req.json().catch(() => null));
      if (!body) return c.json({ error: 'invalid JSON body' }, 400);
      const result = await withTenant(deps.db, tenant.tenantId, async (tx) => {
        const [connection] = await tx
          .select()
          .from(connectorConfigs)
          .where(
            and(
              eq(connectorConfigs.id, id),
              eq(connectorConfigs.type, 'gitlab'),
              isNull(connectorConfigs.deletedAt),
            ),
          )
          .for('update');
        if (!connection) return { error: 'data source not found' };
        if (action === 'revoke') {
          await tx
            .update(gitlabHookAuthorizations)
            .set({ revokedAt: new Date() })
            .where(
              and(
                eq(gitlabHookAuthorizations.connectorId, id),
                isNull(gitlabHookAuthorizations.revokedAt),
              ),
            );
          await deps.secrets.delete(tenant.tenantId, gitLabManagementCredentialKey(id), tx);
          return {
            revoked: true,
            message: 'Management stopped. Existing GitLab hooks were not removed.',
          };
        }
        const readCredential = await deps.secrets.get(
          tenant.tenantId,
          connectorCredentialKey(id),
          tx,
        );
        let review: ReturnType<typeof gitLabManagementReview>;
        try {
          review = gitLabManagementReview(connection, readCredential, body.destination);
        } catch (error) {
          return { error: error instanceof Error ? error.message : 'Invalid management scope.' };
        }
        if (action === 'preview') {
          const catalogScope = and(
            eq(gitlabProjects.connectorId, id),
            eq(gitlabProjects.groupId, review.scope.groupId),
            eq(gitlabProjects.archived, false),
            isNull(gitlabProjects.removedAt),
          );
          const ownershipJoin = and(
            eq(gitlabManagedHooks.connectorId, gitlabProjects.connectorId),
            eq(gitlabManagedHooks.projectId, gitlabProjects.projectId),
          );
          const previewScope = or(
            catalogScope,
            and(
              isNull(gitlabProjects.id),
              eq(gitlabManagedHooks.connectorId, id),
              eq(gitlabManagedHooks.removed, false),
              sql`left(${gitlabManagedHooks.projectPath}, length(${review.scope.groupPath + '/'})) = ${review.scope.groupPath + '/'}`,
            ),
          );
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(gitlabProjects)
            .fullJoin(gitlabManagedHooks, ownershipJoin)
            .where(previewScope);
          const projects = await tx
            .select({
              project: sql<string>`coalesce(${gitlabProjects.fullPath}, ${gitlabManagedHooks.projectPath})`,
              recordedHookId: gitlabManagedHooks.hookId,
              recordId: gitlabManagedHooks.id,
              ownershipId: gitlabManagedHooks.ownershipId,
              attemptedAt: gitlabManagedHooks.createAttemptedAt,
              failureCategory: gitlabManagedHooks.failureCategory,
              action: sql<string>`case when ${gitlabManagedHooks.createAttemptedAt} is not null and ${gitlabManagedHooks.hookId} is null then 'recover' when ${gitlabManagedHooks.hookId} is not null then 'verify_or_update' else 'inspect_or_create' end`,
            })
            .from(gitlabProjects)
            .fullJoin(gitlabManagedHooks, ownershipJoin)
            .where(previewScope)
            .orderBy(
              sql`coalesce(${gitlabManagedHooks.failureCategory} = 'creation_uncertain', false) desc`,
              sql`coalesce(${gitlabProjects.fullPath}, ${gitlabManagedHooks.projectPath})`,
            )
            .limit(20);
          return {
            reviewDigest: review.digest,
            scope: review.scope,
            receiver: review.receiverLabel,
            knownProjects: count?.total ?? 0,
            projects: projects.map(
              ({ recordId, ownershipId, attemptedAt, failureCategory, ...project }) => ({
                ...project,
                ...(failureCategory === 'creation_uncertain' &&
                recordId &&
                ownershipId &&
                attemptedAt
                  ? { recovery: { recordId, ownershipId, attemptedAt: attemptedAt.toISOString() } }
                  : {}),
              }),
            ),
            effect:
              'Create missing owned hooks and maintain their approved events and receiver, including future projects in this group. Unrelated hooks are not adopted or removed. Project membership is rechecked before writes.',
          };
        }
        if (body.approved !== true || body.reviewDigest !== review.digest)
          return { error: 'Review the current scope and explicitly approve ongoing management.' };
        const token = typeof body.managementToken === 'string' ? body.managementToken.trim() : '';
        if (!token || token.length > 4096 || /[\r\n]/.test(token))
          return { error: 'A separate management access token is required.' };
        if (token === gitLabAccessToken(readCredential!))
          return { error: 'Do not reuse the investigation credential for management.' };
        const requested = body.recoveries ?? [];
        if (!Array.isArray(requested) || requested.length > 20)
          return { error: 'Review at most 20 uncertain hooks at a time.' };
        const recoveries: Array<{
          recordId: string;
          ownershipId: string;
          attemptedAt: string;
          projectId: string;
        }> = [];
        for (const raw of requested) {
          const input = requestObject(raw);
          const recordId = connectorInstanceId(String(input?.recordId ?? ''));
          if (
            !recordId ||
            input?.confirmedAbsent !== true ||
            typeof input.attemptedAt !== 'string' ||
            recoveries.some((entry) => entry.recordId === recordId)
          )
            return { error: 'Explicitly confirm each reviewed hook is absent in GitLab.' };
          const [hook] = await tx
            .select()
            .from(gitlabManagedHooks)
            .where(
              and(
                eq(gitlabManagedHooks.id, recordId),
                eq(gitlabManagedHooks.connectorId, id),
                eq(gitlabManagedHooks.removed, false),
                isNull(gitlabManagedHooks.hookId),
                eq(gitlabManagedHooks.failureCategory, 'creation_uncertain'),
              ),
            );
          if (
            !hook?.createAttemptedAt ||
            hook.createAttemptedAt.toISOString() !== input.attemptedAt
          )
            return { error: 'Hook state changed. Refresh the scope and review recovery again.' };
          recoveries.push({
            recordId,
            ownershipId: hook.ownershipId,
            attemptedAt: input.attemptedAt,
            projectId: hook.projectId,
          });
        }
        await tx
          .update(gitlabHookAuthorizations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(gitlabHookAuthorizations.connectorId, id),
              isNull(gitlabHookAuthorizations.revokedAt),
            ),
          );
        await deps.secrets.put(
          tenant.tenantId,
          gitLabManagementCredentialKey(id),
          JSON.stringify({
            accessToken: token,
            destination: review.destination,
            ...(review.webhookSecret ? { webhookSecret: review.webhookSecret } : {}),
            ...(review.signingToken ? { signingToken: review.signingToken } : {}),
          }),
          tx,
        );
        await tx.insert(gitlabHookAuthorizations).values({
          id: randomUUID(),
          tenantId: tenant.tenantId,
          connectorId: id,
          approvedBy: tenant.userId,
          policyVersion: GITLAB_HOOK_POLICY_VERSION,
          lifecycleVersion: connection.lifecycleVersion,
          scope: { ...review.scope, ...(recoveries.length ? { recoveries } : {}) },
        });
        for (const recovery of recoveries) {
          await tx
            .update(gitlabManagedHooks)
            .set({ createAttemptedAt: null, scanPage: 1, failureCategory: 'retry_authorized' })
            .where(eq(gitlabManagedHooks.id, recovery.recordId));
        }
        return {
          authorized: true,
          message:
            'Management authorized. Coverage is pending reconciliation, not proof of delivery.',
        };
      });
      return 'error' in result ? c.json(result, 400) : c.json(result);
    });
  }
}
