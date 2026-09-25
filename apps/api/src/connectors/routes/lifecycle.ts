import { hash } from '../../alertmanager-webhook/normalize';
import {
  reconcileConnectorLifecycle,
  scrubSecrets,
  type ConnectorSignalBinding,
} from '@sre/agent-tools';
import { isConnectorType } from '@sre/connectors';
import {
  bindSignalToEpisodeTx,
  connectorConfigs,
  connectorCredentialKey,
  incidentSignals,
  incidents,
  lockResponseGroupWorkTx,
  withTenant,
} from '@sre/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import type { TenantAuthVariables } from '../../auth';
import type { ConnectorRouteContext } from './context';
import { lockConnectorLifecycle, requestObject } from '../shared';

/** Exposes exact-episode previews, audited legacy binding, and bounded reconciliation. */
export function registerConnectorLifecycleRoutes(
  r: Hono<{ Variables: TenantAuthVariables }>,
  context: ConnectorRouteContext,
): void {
  const { deps } = context;
  r.post('/:type/:id/lifecycle', async (c) => {
    const { tenantId, userId } = c.get('tenant');
    const type = c.req.param('type');
    const id = c.req.param('id');
    if (!isConnectorType(type)) return c.json({ error: 'unsupported connector' }, 400);
    let body: Record<string, unknown> | null;
    try {
      body = requestObject(await c.req.json());
    } catch {
      body = null;
    }
    if (!body || !['preview', 'bind', 'reconcile'].includes(String(body.mode)))
      return c.json({ error: 'invalid lifecycle operation' }, 400);
    const [row] = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select()
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, id),
            eq(connectorConfigs.type, type),
            isNull(connectorConfigs.deletedAt),
          ),
        ),
    );
    if (!row) return c.json({ error: 'not found' }, 404);
    if (!row.enabled) return c.json({ error: 'verify and enable this connector first' }, 409);
    const credential = await deps.secrets.get(tenantId, connectorCredentialKey(id));
    const connector = deps.registry.create({
      id,
      type,
      tenantId,
      name: row.name,
      settings: requestObject(row.settings) ?? {},
      getCredential: async () => credential ?? '',
    });
    Object.defineProperty(connector, 'generation', {
      value: { id, lifecycleVersion: row.lifecycleVersion },
    });
    if (!connector.alertLifecycle?.readEpisode)
      return c.json(
        {
          error:
            'exact episode reads are unsupported; authenticated provider events or operator review are required',
        },
        422,
      );
    if (body.mode === 'reconcile') {
      if (!deps.lifecycle) return c.json({ error: 'lifecycle processing unavailable' }, 503);
      return c.json(
        await reconcileConnectorLifecycle({
          db: deps.db,
          tenantId,
          connector,
          hub: deps.lifecycle.hub,
          queue: deps.lifecycle.route.queue,
        }),
      );
    }
    if (
      typeof body.signalId !== 'string' ||
      typeof body.monitorId !== 'string' ||
      (body.scope !== undefined && typeof body.scope !== 'string') ||
      (body.cycleKey !== undefined &&
        (type !== 'datadog' || typeof body.cycleKey !== 'string' || body.cycleKey.length > 1024)) ||
      (body.family !== undefined && typeof body.family !== 'string')
    )
      return c.json({ error: 'exact signal and provider monitor identifiers are required' }, 400);
    const [target] = await withTenant(deps.db, tenantId, (tx) =>
      tx
        .select({ signal: incidentSignals, incident: incidents })
        .from(incidentSignals)
        .innerJoin(incidents, eq(incidents.id, incidentSignals.incidentId))
        .where(eq(incidentSignals.id, body!.signalId as string)),
    );
    if (!target || target.incident.archivedAt) return c.json({ error: 'signal not found' }, 404);
    if (target.signal.dataSourceId && target.signal.dataSourceId !== id)
      return c.json({ error: 'signal belongs to another connector' }, 409);
    const result = await connector.alertLifecycle.readEpisode({
      monitorId: body.monitorId,
      scope: body.scope as string | undefined,
      cycleKey:
        typeof body.cycleKey === 'string' && body.cycleKey.trim()
          ? body.cycleKey.trim()
          : undefined,
      family: body.family as string | undefined,
      startsAt: target.signal.startsAt ?? undefined,
      observedAt: target.signal.firstSeenAt,
    });
    if (
      result.status !== 'verified' ||
      result.observations.length !== 1 ||
      !result.observations[0]?.startsAt
    )
      return c.json(
        {
          verified: false,
          reason: result.status === 'unverified' ? result.reason : 'ambiguous_episode',
        },
        422,
      );
    const observation = result.observations[0]!;
    const preview = {
      verified: true,
      ...(type === 'datadog'
        ? {
            nativeAssociation:
              typeof body.cycleKey === 'string' && body.cycleKey.trim()
                ? 'awaiting_authenticated_event'
                : 'cycle_key_required',
          }
        : {}),
      signalId: target.signal.id,
      monitorId: body.monitorId,
      provider: observation.provider,
      status: observation.status,
      startsAt: observation.startsAt!.toISOString(),
      endsAt: observation.endsAt?.toISOString() ?? null,
      signalVersion: target.signal.version,
      lifecycleVersion: target.incident.lifecycleVersion,
      connectorVersion: row.lifecycleVersion,
    };
    if (body.mode === 'preview') return c.json(preview);
    if (!deps.lifecycle) return c.json({ error: 'lifecycle processing unavailable' }, 503);
    if (
      typeof body.reason !== 'string' ||
      !body.reason.trim() ||
      body.reason.length > 2000 ||
      body.signalVersion !== target.signal.version ||
      body.lifecycleVersion !== target.incident.lifecycleVersion ||
      body.connectorVersion !== row.lifecycleVersion
    )
      return c.json({ error: 'fresh preview versions and an audit reason are required' }, 409);
    const binding: ConnectorSignalBinding = {
      signalId: target.signal.id,
      monitorId: body.monitorId,
      startsAt: preview.startsAt,
      ...(type === 'datadog' ? { nativeMonitorIdentity: hash(observation.monitorIdentity) } : {}),
      ...(type === 'datadog' && typeof body.cycleKey === 'string' && body.cycleKey.trim()
        ? { nativeEpisodeKey: `datadog:${observation.fingerprint}` }
        : {}),
      ...(typeof body.family === 'string' ? { family: body.family } : {}),
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    };
    let canonicalIncidentId: string | undefined;
    let associationConflict = false;
    let capacityReached = false;
    const saved = await withTenant(deps.db, tenantId, async (tx) => {
      // Save reads settings under this lock without a row lock, so binding must hold it too or a
      // concurrent save writes back settings that omit the new binding.
      await lockConnectorLifecycle(tx, tenantId, id);
      const [config] = await tx
        .select()
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, id),
            eq(connectorConfigs.lifecycleVersion, row.lifecycleVersion),
            eq(connectorConfigs.enabled, true),
            isNull(connectorConfigs.deletedAt),
          ),
        )
        .for('update');
      if (!config) return false;
      // The human append below takes group work locks; they must precede the incident and signal rows.
      await lockResponseGroupWorkTx(tx, tenantId, target.incident.id);
      const [incident] = await tx
        .select()
        .from(incidents)
        .where(eq(incidents.id, target.incident.id))
        .for('update');
      const [signal] = await tx
        .select()
        .from(incidentSignals)
        .where(eq(incidentSignals.id, target.signal.id))
        .for('update');
      if (
        !signal ||
        signal.version !== body!.signalVersion ||
        !incident ||
        incident.lifecycleVersion !== body!.lifecycleVersion ||
        signal.incidentId !== incident.id
      )
        return false;
      const settings = requestObject(config.settings) ?? {};
      const existing = Array.isArray(settings.lifecycleBindings)
        ? (settings.lifecycleBindings as ConnectorSignalBinding[])
        : [];
      const previousAssociation = existing.find(
        (item) => item.signalId === signal.id,
      )?.nativeEpisodeKey;
      if (previousAssociation && previousAssociation !== binding.nativeEpisodeKey) {
        associationConflict = true;
        return false;
      }
      if (existing.length >= 50 && !existing.some((item) => item.signalId === signal.id)) {
        capacityReached = true;
        return false;
      }
      const bound = await bindSignalToEpisodeTx(tx, {
        signalId: signal.id,
        dataSourceId: id,
        episode: { ...observation, startsAt: observation.startsAt! },
      });
      if (bound.status === 'conflict') {
        canonicalIncidentId = bound.incidentId;
        return false;
      }
      await tx
        .update(connectorConfigs)
        .set({
          settings: {
            ...settings,
            lifecycleBindings: [...existing.filter((item) => item.signalId !== signal.id), binding],
          },
          lifecycleVersion: sql`${connectorConfigs.lifecycleVersion} + 1`,
        })
        .where(eq(connectorConfigs.id, id));
      await deps.lifecycle!.hub.appendTxOnce(tx, tenantId, incident.id, {
        author: 'human',
        authorUserId: userId,
        // The hub stores content verbatim, and both values are operator-typed free text.
        content: `Bound signal ${signal.id} to ${type} monitor ${scrubSecrets(binding.monitorId)}, episode ${binding.startsAt}. Reason: ${scrubSecrets((body!.reason as string).trim())}`,
        originMessageId: `connector-binding:${id}:${row.lifecycleVersion}:${signal.id}`,
      });
      return true;
    });
    if (!saved && associationConflict)
      return c.json(
        {
          error:
            'This historical signal is already associated with another native cycle. Keep that association and use a separate signal for the other outage.',
        },
        409,
      );
    // Bindings are never released, so a fresh preview cannot clear this; say so instead of
    // asking for a retry that would fail the same way.
    if (!saved && capacityReached)
      return c.json(
        {
          error: 'binding capacity reached',
          nextStep:
            'This connector already holds the maximum of 50 historical episode bindings. Close this incident through the incident lifecycle with an audited reason instead of binding it.',
        },
        409,
      );
    if (!saved)
      return canonicalIncidentId
        ? c.json(
            {
              error: 'This native cycle already has a canonical incident.',
              canonicalIncidentId,
              nextStep:
                'Review the canonical incident and administratively close the legacy duplicate with an audited supersession reason. This is administrative cleanup, not provider recovery; rebinding cannot merge these records.',
            },
            409,
          )
        : c.json({ error: 'state changed; preview again' }, 409);
    return c.json({
      ...preview,
      bound: true,
      nextStep:
        (type === 'datadog'
          ? binding.nativeEpisodeKey
            ? 'Native association awaits an authenticated Triggered delivery with this exact monitor, group, cycle and start. Replay that provider delivery; a different start remains pending for repair. '
            : 'Read reconciliation is available. Native deduplication requires an explicit cycle key from the Datadog webhook delivery; enter it and bind again, then replay the authenticated Triggered delivery. '
          : '') +
        'Select Provider signals clear in the incident resolution policy, then reconcile this connector. Original signal history is preserved.',
    });
  });
}
