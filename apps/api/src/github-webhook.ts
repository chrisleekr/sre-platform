import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  connectorConfigs,
  connectorCredentialKey,
  markGitHubRepositoryRemoved,
  recordGitHubEvent,
  syncGitHubRepositories,
  upsertDeployments,
  upsertGitHubRepository,
  withTenant,
  type Db,
  type GitHubRepositoryInput,
  type NewDeploy,
  type SecretStore,
  type Tx,
} from '@sre/db';
import { githubWebhookSecret } from '@sre/connectors';
import type { Logger } from './logger';
import { readBoundedWebhookBody, WebhookPayloadTooLargeError } from './webhook-body';

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;
const HEADER_CHARS = 255;
const ACCEPTED_EVENTS = new Set([
  'ping',
  'installation',
  'installation_repositories',
  'repository',
  'push',
  'pull_request',
  'workflow_run',
  'deployment',
  'deployment_status',
]);

export interface GitHubWebhookDeps {
  /** System-scoped lookup resolves the opaque connector id before tenant RLS is available. */
  adminDb: Db;
  appDb: Db;
  secrets: SecretStore;
  log?: Logger;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  return undefined;
}

function date(value: unknown): Date | undefined {
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function validSignature(raw: string, supplied: string, secret: string): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function repositoryInput(
  payload: Record<string, unknown>,
  installationId: string,
): GitHubRepositoryInput | null {
  const repository = object(payload.repository);
  const repositoryId = identifier(repository.id);
  const fullName = string(repository.full_name);
  const name = string(repository.name);
  const owner = string(object(repository.owner).login) ?? fullName?.split('/')[0];
  const htmlUrl = string(repository.html_url);
  if (!repositoryId || !fullName || !name || !owner || !htmlUrl) return null;
  return {
    installationId,
    repositoryId,
    owner,
    name,
    fullName,
    defaultBranch: string(repository.default_branch),
    private: repository.private === true,
    archived: repository.archived === true,
    htmlUrl,
    pushedAt: date(repository.pushed_at),
  };
}

function repositoryFromList(value: unknown, installationId: string): GitHubRepositoryInput | null {
  return repositoryInput({ repository: value }, installationId);
}

function eventSummary(
  eventType: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const action = string(payload.action);
  if (eventType === 'push') {
    const commits = Array.isArray(payload.commits) ? payload.commits : [];
    const head = object(payload.head_commit);
    return {
      before: string(payload.before),
      after: string(payload.after),
      ref: string(payload.ref),
      forced: payload.forced === true,
      deleted: payload.deleted === true,
      commitCount: commits.length,
      headCommit: {
        id: string(head.id),
        message: string(head.message)?.split('\n')[0],
        timestamp: string(head.timestamp),
        url: string(head.url),
      },
    };
  }
  if (eventType === 'pull_request') {
    const pull = object(payload.pull_request);
    return {
      action,
      number: typeof payload.number === 'number' ? payload.number : undefined,
      title: string(pull.title),
      state: string(pull.state),
      draft: pull.draft === true,
      merged: pull.merged === true,
      headSha: string(object(pull.head).sha),
      baseSha: string(object(pull.base).sha),
      htmlUrl: string(pull.html_url),
      updatedAt: string(pull.updated_at),
    };
  }
  if (eventType === 'workflow_run') {
    const run = object(payload.workflow_run);
    return {
      action,
      id: identifier(run.id),
      name: string(run.name),
      event: string(run.event),
      status: string(run.status),
      conclusion: string(run.conclusion),
      headBranch: string(run.head_branch),
      headSha: string(run.head_sha),
      htmlUrl: string(run.html_url),
      runStartedAt: string(run.run_started_at),
      updatedAt: string(run.updated_at),
    };
  }
  if (eventType === 'deployment' || eventType === 'deployment_status') {
    const deployment = object(payload.deployment);
    const status = object(payload.deployment_status);
    return {
      action,
      deploymentId: identifier(deployment.id),
      statusId: identifier(status.id),
      state: string(status.state),
      sha: string(deployment.sha),
      ref: string(deployment.ref),
      environment: string(status.environment) ?? string(deployment.environment),
      transientEnvironment: deployment.transient_environment === true,
      description: string(status.description),
      logUrl: string(status.log_url),
      environmentUrl: string(status.environment_url),
      createdAt: string(status.created_at) ?? string(deployment.created_at),
      updatedAt: string(status.updated_at) ?? string(deployment.updated_at),
    };
  }
  if (eventType === 'installation' || eventType === 'installation_repositories') {
    const installation = object(payload.installation);
    return {
      action,
      installationId: identifier(installation.id),
      account: string(object(installation.account).login),
      repositorySelection: string(installation.repository_selection),
      repositoriesAdded: Array.isArray(payload.repositories_added)
        ? payload.repositories_added.length
        : undefined,
      repositoriesRemoved: Array.isArray(payload.repositories_removed)
        ? payload.repositories_removed.length
        : undefined,
    };
  }
  if (eventType === 'repository') return { action };
  return { action };
}

function eventOccurredAt(
  eventType: string,
  payload: Record<string, unknown>,
  fallback: Date,
): Date {
  if (eventType === 'push') return date(object(payload.head_commit).timestamp) ?? fallback;
  if (eventType === 'pull_request')
    return date(object(payload.pull_request).updated_at) ?? fallback;
  if (eventType === 'workflow_run')
    return date(object(payload.workflow_run).updated_at) ?? fallback;
  if (eventType === 'deployment_status')
    return date(object(payload.deployment_status).updated_at) ?? fallback;
  if (eventType === 'deployment') return date(object(payload.deployment).updated_at) ?? fallback;
  return date(object(payload.repository).updated_at) ?? fallback;
}

function deploymentRow(
  eventType: string,
  payload: Record<string, unknown>,
  repository: GitHubRepositoryInput | null,
  occurredAt: Date,
): NewDeploy | null {
  if ((eventType !== 'deployment' && eventType !== 'deployment_status') || !repository) return null;
  const deployment = object(payload.deployment);
  const status = object(payload.deployment_status);
  const providerId = identifier(deployment.id);
  const sha = string(deployment.sha);
  if (!providerId || !sha) return null;
  return {
    source: 'github',
    providerId,
    repo: repository.fullName,
    ref: string(deployment.ref),
    environment: string(status.environment) ?? string(deployment.environment),
    transientEnvironment: deployment.transient_environment === true,
    actor: string(object(payload.sender).login),
    sha,
    service: null,
    status: string(status.state) ?? 'pending',
    url: string(status.environment_url) ?? string(status.log_url) ?? null,
    deployedAt: occurredAt,
    providerCreatedAt: date(deployment.created_at) ?? null,
    providerUpdatedAt: date(status.updated_at) ?? date(deployment.updated_at) ?? occurredAt,
  };
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

export function githubWebhookRoutes(deps: GitHubWebhookDeps): Hono {
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
      })
      .from(connectorConfigs)
      .where(
        and(
          or(eq(connectorConfigs.id, connectorId), eq(connectorConfigs.webhookKey, connectorId)),
          eq(connectorConfigs.type, 'github'),
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
    const signature = c.req.header('x-hub-signature-256') ?? '';
    const deliveryId = c.req.header('x-github-delivery') ?? '';
    const eventType = c.req.header('x-github-event') ?? '';
    if (
      !signature ||
      !deliveryId ||
      !eventType ||
      deliveryId.length > HEADER_CHARS ||
      eventType.length > HEADER_CHARS
    ) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'invalid_headers'),
      );
      return c.json({ error: 'invalid webhook headers' }, 400);
    }
    if (!ACCEPTED_EVENTS.has(eventType)) return c.json({ accepted: true, ignored: true }, 202);
    const credential = await deps.secrets.get(
      connector.tenantId,
      connectorCredentialKey(connector.id),
    );
    const secret = credential ? githubWebhookSecret(credential) : null;
    if (!secret || !validSignature(raw, signature, secret)) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'signature_mismatch'),
      );
      deps.log?.error('GitHub webhook rejected', {
        connectorId,
        tenantId: connector.tenantId,
        event: eventType,
        failureCategory: 'signature_mismatch',
      });
      return c.json({ error: 'signature verification failed' }, 401);
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
    const expectedInstallationId = identifier(settings.installationId);
    const installationId = identifier(object(payload.installation).id) ?? expectedInstallationId;
    const installationAction = eventType === 'installation' ? string(payload.action) : undefined;
    if (expectedInstallationId && installationId && installationId !== expectedInstallationId) {
      return c.json({ accepted: true, ignored: true }, 202);
    }
    if (
      !expectedInstallationId &&
      eventType !== 'ping' &&
      !(eventType === 'installation' && installationAction === 'created' && installationId)
    ) {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'installation_unbound'),
      );
      return c.json({ error: 'installation is not configured' }, 409);
    }
    if (!installationId && eventType !== 'ping') {
      await withTenant(deps.appDb, connector.tenantId, (tx) =>
        eventHealth(tx, connector.id, attemptedAt, 'installation_missing'),
      );
      return c.json({ error: 'installation is required' }, 400);
    }

    const repository = installationId ? repositoryInput(payload, installationId) : null;
    const occurredAt = eventOccurredAt(eventType, payload, attemptedAt);
    const summary = eventSummary(eventType, payload);
    const inserted = await withTenant(deps.appDb, connector.tenantId, async (tx) => {
      const fresh = await recordGitHubEvent(tx, connector.tenantId, connector.id, {
        deliveryId,
        eventType,
        action: string(payload.action),
        repositoryId: repository?.repositoryId,
        repositoryFullName: repository?.fullName,
        actor: string(object(payload.sender).login),
        ref: string(payload.ref) ?? string(object(payload.deployment).ref),
        sha:
          string(payload.after) ??
          string(object(payload.workflow_run).head_sha) ??
          string(object(payload.deployment).sha),
        summary,
        occurredAt,
      });
      if (!fresh) {
        await eventHealth(tx, connector.id, attemptedAt, undefined, false);
        return false;
      }

      if (repository)
        await upsertGitHubRepository(tx, connector.tenantId, connector.id, repository);
      if (eventType === 'installation' && installationId) {
        const installation = object(payload.installation);
        const accountLogin = string(object(installation.account).login);
        const repositorySelection = string(installation.repository_selection);
        await tx
          .update(connectorConfigs)
          .set({
            settings: {
              ...settings,
              installationId,
              ...(accountLogin ? { accountLogin } : {}),
              ...(repositorySelection === 'all' || repositorySelection === 'selected'
                ? { repositorySelection }
                : {}),
            },
            ...(installationAction === 'deleted' || installationAction === 'suspend'
              ? { enabled: false }
              : {}),
            updatedAt: sql`now()`,
          })
          .where(eq(connectorConfigs.id, connector.id));
        if (installationAction === 'deleted') {
          await syncGitHubRepositories(tx, connector.tenantId, connector.id, installationId, []);
        } else {
          for (const value of Array.isArray(payload.repositories) ? payload.repositories : []) {
            const added = repositoryFromList(value, installationId);
            if (added) await upsertGitHubRepository(tx, connector.tenantId, connector.id, added);
          }
        }
      }
      if (eventType === 'installation_repositories' && installationId) {
        for (const value of Array.isArray(payload.repositories_added)
          ? payload.repositories_added
          : []) {
          const added = repositoryFromList(value, installationId);
          if (added) await upsertGitHubRepository(tx, connector.tenantId, connector.id, added);
        }
        for (const value of Array.isArray(payload.repositories_removed)
          ? payload.repositories_removed
          : []) {
          const repositoryId = identifier(object(value).id);
          if (repositoryId)
            await markGitHubRepositoryRemoved(tx, connector.tenantId, connector.id, repositoryId);
        }
      }
      if (eventType === 'repository' && string(payload.action) === 'deleted' && repository)
        await markGitHubRepositoryRemoved(
          tx,
          connector.tenantId,
          connector.id,
          repository.repositoryId,
        );
      const deployment = deploymentRow(eventType, payload, repository, occurredAt);
      if (deployment) await upsertDeployments(tx, connector.tenantId, [deployment], connector.id);
      await eventHealth(tx, connector.id, attemptedAt);
      return true;
    });

    deps.log?.info('GitHub webhook accepted', {
      connectorId,
      tenantId: connector.tenantId,
      event: eventType,
      duplicate: !inserted,
      repository: repository?.fullName,
    });
    return c.json({ accepted: true, duplicate: !inserted }, 202);
  });

  return router;
}
