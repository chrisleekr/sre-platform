import {
  object,
  string,
  identifier,
  sameSecret,
  validSigningTokenRequest,
  projectPath,
  projectId,
  withinGroup,
  eventAction,
  eventRef,
  eventSha,
  eventSummary,
  eventOccurredAt,
  projectInput,
  deploymentRow,
} from './gitlab-webhook/mapping';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  connectorConfigs,
  connectorCredentialKey,
  gitlabProjects,
  markGitLabProjectRemoved,
  recordGitLabEvent,
  upsertDeployments,
  upsertGitLabProject,
  withTenant,
  type Db,
  type SecretStore,
  type Tx,
} from '@sre/db';
import {
  gitLabAccessToken,
  gitLabWebhookSecret,
  gitLabWebhookSigningToken,
  matchesGitLabGroupScope,
  type HostLookup,
} from '@sre/connectors';
import type { Logger } from './logger';
import { readBoundedWebhookBody, WebhookPayloadTooLargeError } from './webhook-body';
import { scopedSystemEvent } from './gitlab-webhook/system-events';
import { gitLabWebhookObservationKey } from './gitlab-webhook/observation-key';

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const HEADER_CHARS = 255;
const ACCEPTED_EVENTS = new Map([
  ['Push Hook', 'push'],
  ['Tag Push Hook', 'tag_push'],
  ['Merge Request Hook', 'merge_request'],
  ['Pipeline Hook', 'pipeline'],
  ['Job Hook', 'job'],
  ['Deployment Hook', 'deployment'],
  ['Release Hook', 'release'],
  ['Project Hook', 'project'],
  ['Subgroup Hook', 'subgroup'],
  ['Resource Access Token Hook', 'resource_access_token'],
]);

export interface GitLabWebhookDeps {
  adminDb: Db;
  appDb: Db;
  secrets: SecretStore;
  log?: Logger;
  fetch?: typeof fetch;
  lookup?: HostLookup;
}

async function eventHealth(
  tx: Tx,
  connectorId: string,
  attemptedAt: Date,
  failureCategory?: string,
  countDelivery = true,
): Promise<void> {
  await tx
    .update(connectorConfigs)
    .set({
      eventAttemptedAt: attemptedAt,
      ...(failureCategory
        ? { eventFailureCategory: failureCategory }
        : {
            eventSucceededAt: attemptedAt,
            ...(countDelivery ? { eventCount: sql`${connectorConfigs.eventCount} + 1` } : {}),
            eventFailureCategory: null,
          }),
      updatedAt: sql`now()`,
    })
    .where(eq(connectorConfigs.id, connectorId));
}

export function gitLabWebhookRoutes(deps: GitLabWebhookDeps): Hono {
  const router = new Hono();

  router.post('/:connectorId', async (c) => {
    const connectorId = c.req.param('connectorId');
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        connectorId,
      )
    )
      return c.json({ error: 'not found' }, 404);
    const connectors = await deps.adminDb
      .select({
        id: connectorConfigs.id,
        tenantId: connectorConfigs.tenantId,
        settings: connectorConfigs.settings,
        lifecycleVersion: connectorConfigs.lifecycleVersion,
      })
      .from(connectorConfigs)
      .where(
        and(
          or(eq(connectorConfigs.id, connectorId), eq(connectorConfigs.webhookKey, connectorId)),
          eq(connectorConfigs.type, 'gitlab'),
          isNull(connectorConfigs.deletedAt),
        ),
      )
      .limit(1);
    const connector = connectors[0];
    if (!connector) return c.json({ error: 'not found' }, 404);

    const attemptedAt = new Date();
    const declared = Number(c.req.header('content-length'));
    if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'payload_too_large'),
      );
      return c.json({ error: 'payload too large' }, 413);
    }
    let raw: string;
    try {
      raw = await readBoundedWebhookBody(c.req.raw, MAX_WEBHOOK_BYTES);
    } catch (error) {
      if (!(error instanceof WebhookPayloadTooLargeError)) throw error;
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'payload_too_large'),
      );
      return c.json({ error: 'payload too large' }, 413);
    }

    const eventHeader = c.req.header('x-gitlab-event') ?? '';
    const webhookId = c.req.header('webhook-id') ?? '';
    const deliveryId =
      webhookId || c.req.header('idempotency-key') || c.req.header('x-gitlab-event-uuid') || '';
    if (
      !eventHeader ||
      !deliveryId ||
      eventHeader.length > HEADER_CHARS ||
      deliveryId.length > HEADER_CHARS
    ) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'invalid_headers'),
      );
      return c.json({ error: 'invalid webhook headers' }, 400);
    }
    const credential = await deps.secrets.get(
      connector.tenantId,
      connectorCredentialKey(connector.id),
    );
    const expectedSigningToken = credential ? gitLabWebhookSigningToken(credential) : null;
    const expectedSecret = credential ? gitLabWebhookSecret(credential) : null;
    const suppliedSignature = c.req.header('webhook-signature') ?? '';
    const signatureResult =
      expectedSigningToken && suppliedSignature
        ? validSigningTokenRequest(
            expectedSigningToken,
            webhookId,
            c.req.header('webhook-timestamp') ?? '',
            raw,
            suppliedSignature,
          )
        : null;
    const secretValid =
      !suppliedSignature &&
      Boolean(expectedSecret) &&
      sameSecret(c.req.header('x-gitlab-token') ?? '', expectedSecret!);
    if (signatureResult !== 'valid' && !secretValid) {
      const failureCategory =
        signatureResult === 'stale' ? 'stale_signature' : 'signature_mismatch';
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, failureCategory),
      );
      deps.log?.error('GitLab webhook rejected', {
        connectorId,
        tenantId: connector.tenantId,
        event: eventHeader,
        failureCategory,
      });
      return c.json({ error: 'webhook signature verification failed' }, 401);
    }

    let payload: Record<string, unknown>;
    try {
      payload = object(JSON.parse(raw));
    } catch {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'invalid_json'),
      );
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const settings = object(connector.settings);
    const groupId = identifier(settings.groupId);
    const groupPath = string(settings.groupPath);
    if (!groupId || !groupPath) return c.json({ error: 'connector is not group scoped' }, 409);
    const instance = c.req.header('x-gitlab-instance');
    const baseUrl = string(settings.baseUrl);
    if (instance && baseUrl) {
      try {
        if (new URL(instance).origin !== new URL(baseUrl).origin)
          return c.json({ error: 'GitLab instance mismatch' }, 403);
      } catch {
        return c.json({ error: 'invalid GitLab instance header' }, 400);
      }
    }

    const originalPayload = payload;
    let eventType = ACCEPTED_EVENTS.get(eventHeader);
    let systemRemoved = false;
    if (eventHeader === 'System Hook') {
      if (settings.eventStrategy !== 'system' || !baseUrl)
        return c.json({ accepted: true, ignored: true }, 202);
      const system = scopedSystemEvent(payload, groupPath, baseUrl);
      if (!system) return c.json({ accepted: true, ignored: true }, 202);
      payload = system.payload;
      eventType = system.eventType;
      systemRemoved = system.removed;
    }
    const fullPath = projectPath(payload);
    if (!withinGroup(fullPath, groupPath)) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'group_mismatch'),
      );
      return c.json({ error: 'project is outside the configured group' }, 403);
    }
    if (!eventType) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, undefined, false),
      );
      return c.json({ accepted: true, ignored: true }, 202);
    }

    if (settings.eventStrategy === 'system') {
      // Instance-wide hooks do not prove group membership. Namespace paths can be reused.
      try {
        const token = credential ? gitLabAccessToken(credential) : null;
        if (!token || !(await matchesGitLabGroupScope(settings, token, deps.fetch, deps.lookup))) {
          await withTenant(deps.appDb, connector.tenantId, (tx) =>
            eventHealth(tx, connector.id, attemptedAt, 'group_scope_changed'),
          );
          return c.json({ error: 'configured GitLab group scope changed' }, 403);
        }
      } catch {
        await withTenant(deps.appDb, connector.tenantId, (tx) =>
          eventHealth(tx, connector.id, attemptedAt, 'group_scope_unverified'),
        );
        return c.json({ error: 'could not verify configured GitLab group scope' }, 503);
      }
    }
    const occurredAt = eventOccurredAt(eventType, payload, attemptedAt);
    const input = projectInput(payload, groupId);
    const inserted = await withTenant(deps.appDb, connector.tenantId, async (tx) => {
      const current = await tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, connector.id),
            eq(connectorConfigs.lifecycleVersion, connector.lifecycleVersion),
            isNull(connectorConfigs.deletedAt),
          ),
        )
        .for('update');
      if (current.length === 0) return null;
      const fresh = await recordGitLabEvent(tx, connector.tenantId, connector.id, {
        deliveryId,
        observationKey: gitLabWebhookObservationKey(
          eventType,
          originalPayload,
          c.req.header('x-gitlab-event-uuid'),
        ),
        eventType,
        action: eventAction(eventType, payload),
        projectId: projectId(payload),
        projectFullPath: fullPath,
        actor:
          string(payload.user_username) ??
          string(object(payload.user).username) ??
          string(object(payload.author).username),
        ref: eventRef(eventType, payload),
        sha: eventSha(eventType, payload),
        summary: {
          ...eventSummary(eventType, payload),
          ...(eventHeader === 'System Hook' ? { delivery: 'system_hook' } : {}),
        },
        occurredAt,
      });
      if (!fresh) {
        await eventHealth(tx, connector.id, attemptedAt, undefined, false);
        return false;
      }
      if (input && !systemRemoved) {
        if (eventHeader === 'System Hook' && eventType === 'project') {
          const [existing] = await tx
            .select({ archived: gitlabProjects.archived })
            .from(gitlabProjects)
            .where(
              and(
                eq(gitlabProjects.connectorId, connector.id),
                eq(gitlabProjects.projectId, input.projectId),
              ),
            );
          input.archived = existing?.archived ?? false;
        }
        await upsertGitLabProject(tx, connector.tenantId, connector.id, input);
      }
      if (
        systemRemoved ||
        (eventType === 'project' && string(payload.event_name) === 'project_destroy')
      ) {
        const removedId = projectId(payload);
        if (removedId)
          await markGitLabProjectRemoved(tx, connector.tenantId, connector.id, removedId);
      }
      const deployment = deploymentRow(eventType, payload, fullPath, occurredAt);
      if (deployment) await upsertDeployments(tx, connector.tenantId, [deployment], connector.id);
      await eventHealth(tx, connector.id, attemptedAt);
      return true;
    });

    if (inserted === null)
      return c.json({ error: 'connector configuration changed; retry delivery' }, 409);

    deps.log?.info('GitLab webhook accepted', {
      connectorId,
      tenantId: connector.tenantId,
      event: eventType,
      duplicate: !inserted,
      project: fullPath,
    });
    return c.json({ accepted: true, duplicate: !inserted }, 202);
  });

  return router;
}
