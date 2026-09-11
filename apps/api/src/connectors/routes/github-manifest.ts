import {
  convertGitHubAppManifest,
  githubCredentialBundle,
  type GitHubManifestConversion,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  githubManifestSessions,
  withTenant,
} from '@sre/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { type TenantAuthVariables } from '../../auth';

import {
  GITHUB_APP_EVENTS,
  GITHUB_MANIFEST_TTL_MS,
  dataSourceName,
  defaultDataSourceName,
  externalUrl,
  githubAppOwnerPath,
  isUniqueViolation,
  lockConnectorLifecycle,
  manifestStateHash,
  requestObject,
  connectorInstanceId,
} from '../helpers';

export type { ConnectorRoutesDeps } from '../helpers';

import type { ConnectorRouteContext } from './context';

export function registerGitHubManifestRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps, reconcileGitHubSmee } = context;
  r.post('/github/manifest/start', async (c) => {
    const { tenantId } = c.get('tenant');
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);
    const setupId = body.setupId === undefined ? undefined : connectorInstanceId(body.setupId);
    if (body.setupId !== undefined && !setupId) return c.json({ error: 'invalid setup ID' }, 400);
    const name =
      body.name === undefined ? defaultDataSourceName('github') : dataSourceName(body.name);
    if (!name) return c.json({ error: 'data source name must be 1 to 80 characters' }, 400);
    const ownerType = body.ownerType;
    const organization =
      typeof body.organization === 'string' ? body.organization.trim() : undefined;
    const actionUrl = githubAppOwnerPath(String(ownerType ?? ''), organization);
    if (!actionUrl) return c.json({ error: 'invalid GitHub App owner' }, 400);
    const dashboard = externalUrl(body.dashboardUrl, true);
    if (!dashboard) return c.json({ error: 'invalid dashboard URL' }, 400);
    const deliveryMode = body.deliveryMode;
    if (deliveryMode !== 'direct' && deliveryMode !== 'smee')
      return c.json({ error: 'deliveryMode must be direct or smee' }, 400);
    const suppliedDelivery = externalUrl(body.deliveryUrl, false);
    if (!suppliedDelivery) return c.json({ error: 'webhook delivery URL must use HTTPS' }, 400);
    if (deliveryMode === 'smee' && suppliedDelivery.hostname !== 'smee.io')
      return c.json({ error: 'Smee delivery requires an https://smee.io channel URL' }, 400);
    if (deliveryMode === 'direct' && suppliedDelivery.hostname === 'smee.io')
      return c.json({ error: 'Choose Smee delivery for an https://smee.io channel URL' }, 400);
    if (deliveryMode === 'direct' && suppliedDelivery.pathname !== '/')
      return c.json({ error: 'Direct delivery requires an HTTPS API origin without a path' }, 400);

    const state = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + GITHUB_MANIFEST_TTL_MS);
    const session = await withTenant(deps.db, tenantId, async (tx) => {
      await lockConnectorLifecycle(tx, tenantId, `github-name:${name.toLowerCase()}`);
      await tx
        .delete(githubManifestSessions)
        .where(lt(githubManifestSessions.expiresAt, new Date()));
      const activeName = await tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.type, 'github'),
            isNull(connectorConfigs.deletedAt),
            sql`lower(${connectorConfigs.name}) = ${name.toLowerCase()}`,
          ),
        )
        .limit(1);
      const pendingName = await tx
        .select({ id: githubManifestSessions.id })
        .from(githubManifestSessions)
        .where(sql`lower(${githubManifestSessions.dataSourceName}) = ${name.toLowerCase()}`)
        .limit(1);
      if (activeName[0] || pendingName[0]) return null;
      const rows = await tx
        .insert(githubManifestSessions)
        .values({
          tenantId,
          dataSourceName: name,
          ...(setupId ? { id: setupId } : {}),
          stateHash: manifestStateHash(state),
          ownerType: String(ownerType),
          organization: organization ?? null,
          // Direct mode treats deliveryUrl as the public API origin. Smee mode uses the channel URL.
          webhookUrl:
            deliveryMode === 'direct'
              ? new URL(`/webhooks/github/PENDING`, suppliedDelivery.origin).toString()
              : suppliedDelivery.toString(),
          redirectUrl: new URL('/connectors', dashboard.origin).toString(),
          expiresAt,
        })
        .onConflictDoNothing()
        .returning({ id: githubManifestSessions.id });
      return rows[0] ?? null;
    });
    if (!session)
      return c.json(
        { error: 'a GitHub data source with this name already exists or is being set up' },
        409,
      );
    const webhookUrl =
      deliveryMode === 'direct'
        ? new URL(`/webhooks/github/${session.id}`, suppliedDelivery.origin).toString()
        : suppliedDelivery.toString();
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .update(githubManifestSessions)
        .set({ webhookUrl })
        .where(eq(githubManifestSessions.id, session.id)),
    );
    const redirectUrl = new URL('/connectors', dashboard.origin).toString();
    const manifest = {
      name: `SRE Platform ${session.id.slice(0, 8)}`,
      url: dashboard.origin,
      description: 'Read-only code and change evidence for incident investigation',
      hook_attributes: { url: webhookUrl, active: true },
      redirect_url: redirectUrl,
      setup_url: redirectUrl,
      setup_on_update: true,
      public: false,
      default_permissions: {
        contents: 'read',
        pull_requests: 'read',
        actions: 'read',
        deployments: 'read',
      },
      default_events: [...GITHUB_APP_EVENTS],
    };
    return c.json({
      actionUrl: `${actionUrl}?state=${encodeURIComponent(state)}`,
      state,
      manifest,
      webhookUrl,
      localWebhookPath: `/webhooks/github/${session.id}`,
      expiresAt,
    });
  });

  r.post('/github/manifest/complete', async (c) => {
    const { tenantId } = c.get('tenant');
    let parsed: unknown;
    try {
      parsed = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const body = requestObject(parsed);
    const code = typeof body?.code === 'string' ? body.code.trim() : '';
    const state = typeof body?.state === 'string' ? body.state.trim() : '';
    if (!code || !state) return c.json({ error: 'manifest code and state are required' }, 400);
    const captured = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(githubManifestSessions)
        .where(eq(githubManifestSessions.stateHash, manifestStateHash(state)))
        .limit(1);
      return rows[0] ?? null;
    });
    if (!captured || captured.expiresAt.getTime() <= Date.now())
      return c.json({ error: 'GitHub App setup session expired or did not match' }, 400);

    const nameTaken = await withTenant(deps.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.type, 'github'),
            isNull(connectorConfigs.deletedAt),
            sql`lower(${connectorConfigs.name}) = ${captured.dataSourceName.toLowerCase()}`,
          ),
        )
        .limit(1);
      return Boolean(rows[0]);
    });
    if (nameTaken)
      return c.json({ error: 'a GitHub data source with this name already exists' }, 409);

    let conversion: GitHubManifestConversion;
    try {
      const convert = deps.convertGitHubAppManifest ?? convertGitHubAppManifest;
      conversion = await convert(code);
    } catch {
      return c.json({ error: 'GitHub App manifest conversion failed' }, 502);
    }
    const eventTransport = captured.webhookUrl.startsWith('https://smee.io/') ? 'smee' : 'direct';
    let stored: string | false;
    try {
      stored = await withTenant(deps.db, tenantId, async (tx) => {
        await lockConnectorLifecycle(tx, tenantId, captured.id);
        const session = await tx
          .select({ id: githubManifestSessions.id })
          .from(githubManifestSessions)
          .where(
            and(
              eq(githubManifestSessions.id, captured.id),
              eq(githubManifestSessions.stateHash, manifestStateHash(state)),
            ),
          )
          .limit(1);
        if (!session[0]) return false;
        const settings = {
          appId: conversion.appId,
          appSlug: conversion.appSlug,
          eventTransport,
        };
        await tx.insert(connectorConfigs).values({
          id: captured.id,
          tenantId,
          name: captured.dataSourceName,
          type: 'github',
          webhookKey: captured.id,
          settings,
          enabled: false,
        });
        await deps.secrets.put(
          tenantId,
          connectorCredentialKey(captured.id),
          githubCredentialBundle(
            conversion.privateKey,
            conversion.webhookSecret,
            eventTransport === 'smee' ? captured.webhookUrl : undefined,
          ),
          tx,
        );
        await tx.delete(githubManifestSessions).where(eq(githubManifestSessions.id, captured.id));
        return captured.id;
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await withTenant(deps.db, tenantId, (tx) =>
        tx.delete(githubManifestSessions).where(eq(githubManifestSessions.id, captured.id)),
      );
      return c.json(
        {
          error:
            'GitHub created the App, but the data source name was taken. Delete the new App and restart setup with a unique name.',
        },
        409,
      );
    }
    if (!stored) return c.json({ error: 'GitHub App setup session changed; retry' }, 409);
    await deps.cache?.delete?.(tenantId, 'github').catch(() => {});
    const relayStatus = await reconcileGitHubSmee(
      tenantId,
      stored,
      { eventTransport },
      githubCredentialBundle(
        conversion.privateKey,
        conversion.webhookSecret,
        eventTransport === 'smee' ? captured.webhookUrl : undefined,
      ),
      captured.id,
    );
    return c.json({
      appId: conversion.appId,
      connectorId: stored,
      name: captured.dataSourceName,
      appSlug: conversion.appSlug,
      appUrl: conversion.appUrl,
      installUrl: `https://github.com/apps/${encodeURIComponent(conversion.appSlug)}/installations/new`,
      eventTransport,
      localWebhookPath: `/webhooks/github/${captured.id}`,
      ...(relayStatus ? { relayStatus } : {}),
    });
  });
}
