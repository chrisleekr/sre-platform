import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  connectorConfigs,
  gitlabHookAuthorizations,
  gitlabManagedHooks,
  gitLabManagementCredentialKey,
  withTenant,
  type Db,
  type SecretStore,
  type Tx,
} from '@sre/db';
import type { HostLookup } from '@sre/connectors';
import { GITLAB_HOOK_POLICY_VERSION, GITLAB_MANAGED_HOOK_EVENTS } from '@sre/contracts';
import {
  ManagementFailure,
  inGroup,
  managementClient,
  marker,
  object,
  providerId,
  type ManagementCredential,
} from './client';

export interface HookManagementDeps {
  db: Db;
  secrets: SecretStore;
  fetch?: typeof fetch;
  lookup?: HostLookup;
}
type Hook = typeof gitlabManagedHooks.$inferSelect;
type Authority = typeof gitlabHookAuthorizations.$inferSelect;
type Connection = typeof connectorConfigs.$inferSelect;
type Client = Awaited<ReturnType<typeof managementClient>>;
interface Scope {
  tx: Tx;
  authority: Authority;
  connection: Connection;
  client: Client;
  groupPath: string;
  groupId: string;
}

async function withAuthority<T>(
  deps: HookManagementDeps,
  tenantId: string,
  connectorId: string,
  operation: (scope: Scope) => Promise<T>,
  expectedAuthorizationId?: string,
) {
  return withTenant(deps.db, tenantId, async (tx) => {
    // Save, disable and delete update this row. Revocation takes the same lock before its own row.
    const [connection] = await tx
      .select()
      .from(connectorConfigs)
      .where(
        and(
          eq(connectorConfigs.id, connectorId),
          eq(connectorConfigs.type, 'gitlab'),
          eq(connectorConfigs.enabled, true),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .for('update');
    if (!connection || object(connection.settings).eventStrategy !== 'managed_projects') return;
    const [authority] = await tx
      .select()
      .from(gitlabHookAuthorizations)
      .where(
        and(
          eq(gitlabHookAuthorizations.connectorId, connectorId),
          isNull(gitlabHookAuthorizations.revokedAt),
        ),
      )
      .for('update');
    if (
      !authority ||
      authority.revokedAt ||
      authority.policyVersion !== GITLAB_HOOK_POLICY_VERSION ||
      authority.lifecycleVersion !== connection.lifecycleVersion ||
      (expectedAuthorizationId && authority.id !== expectedAuthorizationId) ||
      (authority.retryAt && authority.retryAt.getTime() > Date.now())
    )
      return;
    const settings = object(connection.settings);
    if (
      !settings.groupPath ||
      typeof settings.groupPath !== 'string' ||
      !settings.baseUrl ||
      typeof settings.baseUrl !== 'string' ||
      !['direct', 'smee'].includes(String(settings.eventTransport))
    )
      return;
    try {
      const raw = await deps.secrets.get(tenantId, gitLabManagementCredentialKey(connectorId), tx);
      if (!raw) throw new ManagementFailure('missing_management_credential');
      const credential = JSON.parse(raw) as ManagementCredential;
      const approvedScope = object(authority.scope);
      const approvedEvents = object(approvedScope.events);
      if (
        approvedScope.baseUrl !== settings.baseUrl ||
        approvedScope.groupId !== String(settings.groupId) ||
        approvedScope.groupPath !== settings.groupPath ||
        approvedScope.transport !== settings.eventTransport ||
        approvedScope.destinationDigest !==
          createHash('sha256').update(credential.destination).digest('hex') ||
        Object.keys(approvedEvents).length !== Object.keys(GITLAB_MANAGED_HOOK_EVENTS).length ||
        !Object.entries(GITLAB_MANAGED_HOOK_EVENTS).every(
          ([key, enabled]) => approvedEvents[key] === enabled,
        )
      )
        throw new ManagementFailure('approval_scope_changed');
      const client = await managementClient(
        settings.baseUrl,
        credential,
        deps.fetch ?? fetch,
        deps.lookup,
      );
      return await operation({
        tx,
        authority,
        connection,
        client,
        groupPath: settings.groupPath,
        groupId: providerId(settings.groupId),
      });
    } catch (error) {
      const category = error instanceof ManagementFailure ? error.category : 'provider_unavailable';
      await tx
        .update(gitlabHookAuthorizations)
        .set({
          failureCategory: category,
          ...(category === 'rate_limited' ? { retryAt: new Date(Date.now() + 60_000) } : {}),
        })
        .where(eq(gitlabHookAuthorizations.id, authority.id));
    }
  });
}

async function checkGroup(scope: Scope) {
  const group = await scope.client.group(scope.groupId);
  if (providerId(group.id) !== scope.groupId || group.full_path !== scope.groupPath)
    throw new ManagementFailure('group_scope_changed');
}

async function checkProject(scope: Scope, hook: Hook) {
  await checkGroup(scope);
  const project = await scope.client.project(hook.projectId);
  if (providerId(project.id) !== hook.projectId)
    throw new ManagementFailure('invalid_provider_identity');
  if (!inGroup(project.path_with_namespace, scope.groupPath)) {
    await scope.tx
      .update(gitlabManagedHooks)
      .set({ removed: true, failureCategory: 'out_of_scope' })
      .where(eq(gitlabManagedHooks.id, hook.id));
    return false;
  }
  return true;
}

function owned(value: Record<string, unknown>, hook: Hook) {
  if (
    providerId(value.project_id) !== hook.projectId ||
    value.description !== marker(hook.ownershipId) ||
    (hook.hookId && providerId(value.id) !== hook.hookId)
  )
    throw new ManagementFailure('ownership_conflict');
  return providerId(value.id);
}

async function healthy(scope: Scope, hook: Hook, remote: Record<string, unknown>) {
  await scope.tx
    .update(gitlabManagedHooks)
    .set({
      hookId: owned(remote, hook),
      succeededAt: new Date(),
      appliedAuthorizationId: scope.authority.id,
      failureCategory: null,
      scanPage: 1,
    })
    .where(eq(gitlabManagedHooks.id, hook.id));
}

/**
 * Reconcile one catalog page and one owned project hook, never using the investigation credential.
 * @param deps - Tenant database, isolated secret store and provider transport.
 * @param tenantId - Workspace owning the authorization and hook intents.
 * @param connectorId - Enabled connection whose generation must match the approval.
 */
export async function reconcileGitLabHooks(
  deps: HookManagementDeps,
  tenantId: string,
  connectorId: string,
): Promise<void> {
  await withAuthority(deps, tenantId, connectorId, async (scope) => {
    await checkGroup(scope);
    const page = await scope.client.catalog(scope.groupId, scope.authority.catalogPage);
    for (const project of page.values) {
      if (!inGroup(project.path_with_namespace, scope.groupPath) || project.archived === true)
        continue;
      await scope.tx
        .insert(gitlabManagedHooks)
        .values({
          tenantId,
          connectorId,
          projectId: providerId(project.id),
          projectPath: project.path_with_namespace,
        })
        .onConflictDoUpdate({
          target: [
            gitlabManagedHooks.tenantId,
            gitlabManagedHooks.connectorId,
            gitlabManagedHooks.projectId,
          ],
          set: { projectPath: project.path_with_namespace, removed: false },
        });
    }
    await scope.tx
      .update(gitlabHookAuthorizations)
      .set({
        catalogPage: page.more ? scope.authority.catalogPage + 1 : 1,
        catalogCheckedAt: new Date(),
        failureCategory: null,
        retryAt: null,
      })
      .where(eq(gitlabHookAuthorizations.id, scope.authority.id));
  });

  // Commit the create intent before sending POST. A retry may recover its marker but cannot POST again.
  const permit = await withAuthority(deps, tenantId, connectorId, async (scope) => {
    const [hook] = await scope.tx
      .select()
      .from(gitlabManagedHooks)
      .where(
        and(eq(gitlabManagedHooks.connectorId, connectorId), eq(gitlabManagedHooks.removed, false)),
      )
      .orderBy(sql`${gitlabManagedHooks.attemptedAt} asc nulls first`, gitlabManagedHooks.id)
      .limit(1);
    if (!hook) return;
    await scope.tx
      .update(gitlabManagedHooks)
      .set({ attemptedAt: new Date() })
      .where(eq(gitlabManagedHooks.id, hook.id));
    try {
      if (!(await checkProject(scope, hook))) return;
      if (hook.hookId) {
        let remote: Record<string, unknown>;
        try {
          remote = await scope.client.hook(hook.projectId, hook.hookId);
        } catch (error) {
          if (!(error instanceof ManagementFailure) || error.category !== 'not_found') throw error;
          await scope.tx
            .update(gitlabManagedHooks)
            .set({
              hookId: null,
              createAttemptedAt: null,
              succeededAt: null,
              failureCategory: 'hook_missing',
              scanPage: 1,
            })
            .where(eq(gitlabManagedHooks.id, hook.id));
          return;
        }
        owned(remote, hook);
        const raw = await deps.secrets.get(
          tenantId,
          gitLabManagementCredentialKey(connectorId),
          scope.tx,
        );
        const credential = JSON.parse(raw!) as ManagementCredential;
        const matches =
          remote.url === credential.destination &&
          remote.enable_ssl_verification === true &&
          remote.branch_filter_strategy === 'all_branches' &&
          (remote.push_events_branch_filter ?? '') === '' &&
          Object.entries(GITLAB_MANAGED_HOOK_EVENTS).every(
            ([key, enabled]) => (remote[key] ?? false) === enabled,
          );
        if (hook.appliedAuthorizationId !== scope.authority.id || !matches)
          remote = await scope.client.update(hook.projectId, hook.hookId, hook.ownershipId);
        await healthy(scope, hook, remote);
        return;
      }
      const page = await scope.client.hooks(hook.projectId, hook.scanPage);
      const matches = page.values.filter((value) => value.description === marker(hook.ownershipId));
      if (matches.length > 1) throw new ManagementFailure('ownership_conflict');
      if (matches[0]) {
        // Persist recovered identity first. The next run applies and verifies the approved settings.
        await scope.tx
          .update(gitlabManagedHooks)
          .set({
            hookId: owned(matches[0], hook),
            scanPage: 1,
            failureCategory: 'verification_pending',
          })
          .where(eq(gitlabManagedHooks.id, hook.id));
        return;
      }
      if (page.more) {
        await scope.tx
          .update(gitlabManagedHooks)
          .set({ scanPage: hook.scanPage + 1 })
          .where(eq(gitlabManagedHooks.id, hook.id));
        return;
      }
      if (hook.createAttemptedAt) {
        await scope.tx
          .update(gitlabManagedHooks)
          .set({ scanPage: 1, failureCategory: 'creation_uncertain' })
          .where(eq(gitlabManagedHooks.id, hook.id));
        return;
      }
      await scope.tx
        .update(gitlabManagedHooks)
        .set({ createAttemptedAt: new Date(), failureCategory: 'creation_pending', scanPage: 1 })
        .where(eq(gitlabManagedHooks.id, hook.id));
      return { hook, authorizationId: scope.authority.id };
    } catch (error) {
      await scope.tx
        .update(gitlabManagedHooks)
        .set({
          failureCategory:
            error instanceof ManagementFailure ? error.category : 'provider_unavailable',
        })
        .where(eq(gitlabManagedHooks.id, hook.id));
      throw error;
    }
  });
  if (!permit) return;
  await withAuthority(
    deps,
    tenantId,
    connectorId,
    async (scope) => {
      const [hook] = await scope.tx
        .select()
        .from(gitlabManagedHooks)
        .where(eq(gitlabManagedHooks.id, permit.hook.id));
      if (!hook || hook.hookId || hook.removed || hook.ownershipId !== permit.hook.ownershipId)
        return;
      let createDispatched = false;
      try {
        if (!(await checkProject(scope, hook))) {
          await scope.tx
            .update(gitlabManagedHooks)
            .set({ createAttemptedAt: null })
            .where(eq(gitlabManagedHooks.id, hook.id));
          return;
        }
        createDispatched = true;
        await healthy(scope, hook, await scope.client.create(hook.projectId, hook.ownershipId));
      } catch (error) {
        if (
          !createDispatched ||
          (error instanceof ManagementFailure &&
            ['permission_denied', 'rate_limited', 'not_found'].includes(error.category))
        ) {
          // No dispatch or an explicit rejection is retryable. Ambiguous POST outcomes stay fenced.
          await scope.tx
            .update(gitlabManagedHooks)
            .set({
              createAttemptedAt: null,
              failureCategory:
                error instanceof ManagementFailure ? error.category : 'provider_unavailable',
            })
            .where(eq(gitlabManagedHooks.id, hook.id));
        }
        throw error;
      }
    },
    permit.authorizationId,
  );
}
