import { Hono } from 'hono';
import {
  upsertService,
  updateService,
  listServices,
  deleteService,
  addDependency,
  updateDependency,
  listDependencies,
  removeDependency,
  recentDeploys,
  listActiveIncidentServices,
  connectorConfigs,
  withTenant,
  type Db,
  type DeployRow,
} from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { SnapshotCache } from '@sre/queue';
import { computeBlastRadius } from '@sre/topology';
import {
  authMiddleware,
  requireTenantConfigurationAdmin,
  type AuthDeps,
  type TenantAuthVariables,
} from './auth';
import { toInfraSnapshot } from './snapshots';

export interface TopologyRoutesDeps {
  auth: AuthDeps;
  /** RLS-scoped (app_user) connection. */
  db: Db;
  /** Latest tenant-scoped runtime inventory, used only to discover live service namespaces. */
  cache: SnapshotCache;
}

const SYNC_TYPES = new Set(['sync', 'async']);
const CRITICALITY = new Set(['tier1', 'tier2', 'tier3']);

/**
 * A Postgres foreign_key_violation (SQLSTATE 23503) — the only DB error these routes translate to a
 * client 4xx. Any other error (timeout, deadlock, RLS misconfig) must propagate so Hono returns a 500
 * (retryable + alertable), never a misleading 4xx. Hono's default handler leaks no DB detail (CWE-209).
 */
function isFkViolation(e: unknown): boolean {
  // drizzle wraps DB errors in DrizzleQueryError, so the postgres.js SQLSTATE (23503) is on
  // `.cause.code`; fall back to `.code` for an unwrapped driver error.
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === '23503';
}

/**
 * Tenant-facing CRUD for the service dependency graph. RLS-scoped; any authed tenant
 * member can read and write (flat membership). Manual seeding for now; auto-discovery from
 * tracing is deferred (no source yet).
 */
export function topologyRoutes(deps: TopologyRoutesDeps): Hono<{ Variables: TenantAuthVariables }> {
  const r = new Hono<{ Variables: TenantAuthVariables }>();
  r.use('*', authMiddleware(deps.auth));
  r.use('*', requireTenantConfigurationAdmin());

  r.get('/services', async (c) => {
    const { tenantId } = c.get('tenant');
    return c.json({ services: await listServices(deps.db, tenantId) });
  });

  // Compose the operational inventory from the durable catalog plus live, attributable signals. Only
  // service-to-service edges remain manual: pod co-location is not evidence that one service calls another.
  r.get('/graph', async (c) => {
    const { tenantId } = c.get('tenant');
    const [svcs, dependencies, deploys, activeIncidentServices, kubernetesSources] =
      await Promise.all([
        listServices(deps.db, tenantId),
        listDependencies(deps.db, tenantId),
        recentDeploys(deps.db, tenantId, { perService: 5 }),
        listActiveIncidentServices(deps.db, tenantId),
        withTenant(deps.db, tenantId, (tx) =>
          tx
            .select({
              id: connectorConfigs.id,
              name: connectorConfigs.name,
              lifecycleVersion: connectorConfigs.lifecycleVersion,
            })
            .from(connectorConfigs)
            .where(
              and(
                eq(connectorConfigs.type, 'kubernetes'),
                eq(connectorConfigs.enabled, true),
                isNull(connectorConfigs.deletedAt),
              ),
            ),
        ),
      ]);
    const infrastructure = (
      await Promise.all(
        kubernetesSources.map(async (dataSource) => ({
          dataSource,
          snapshots: await deps.cache.get(tenantId, 'kubernetes', dataSource),
        })),
      )
    ).flatMap(({ dataSource, snapshots }) =>
      snapshots.map((snapshot) => toInfraSnapshot(snapshot, dataSource)),
    );
    const incidentServices = new Set(activeIncidentServices);
    const kubernetesServices = new Set(
      infrastructure.flatMap((snapshot) =>
        snapshot.kind === 'pod' && snapshot.namespace ? [snapshot.namespace] : [],
      ),
    );
    const byService = new Map<string, DeployRow[]>();
    for (const d of deploys) {
      if (!d.service) continue;
      const arr = byService.get(d.service);
      if (arr) arr.push(d);
      else byService.set(d.service, [d]);
    }
    const catalogByName = new Map(svcs.map((service) => [service.name, service]));
    const names = new Set([
      ...catalogByName.keys(),
      ...byService.keys(),
      ...incidentServices,
      ...kubernetesServices,
    ]);
    const nodes = [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => {
        const service = catalogByName.get(name);
        const ds = byService.get(name) ?? [];
        const latest = ds[0];
        const sources: Array<'catalog' | 'kubernetes' | 'incident' | 'deployment'> = [];
        if (service) sources.push('catalog');
        if (kubernetesServices.has(name)) sources.push('kubernetes');
        if (incidentServices.has(name)) sources.push('incident');
        if (ds.length > 0) sources.push('deployment');
        return {
          name,
          team: service?.team ?? null,
          criticality: service?.criticality ?? null,
          sources,
          lastDeployAt: latest ? latest.deployedAt.toISOString() : null,
          recentDeploys: ds.map((d) => ({
            sha: d.sha,
            ref: d.ref,
            status: d.status,
            deployedAt: d.deployedAt.toISOString(),
          })),
        };
      });
    const edges = dependencies.map((d) => ({
      upstream: d.upstream,
      downstream: d.downstream,
      syncType: d.syncType,
      circuitBreaker: d.circuitBreaker,
    }));
    return c.json({ nodes, edges, infrastructure });
  });

  // On-demand blast radius for a service (incident overlay). Wraps the recursive-CTE query in
  // @sre/topology; RLS-scoped. `mapped: false` in the payload signals a service that isn't a graph node.
  r.get('/blast-radius', async (c) => {
    const { tenantId } = c.get('tenant');
    const service = c.req.query('service');
    if (!service) return c.json({ error: 'service query param is required' }, 400);
    return c.json(await computeBlastRadius(deps.db, tenantId, service));
  });

  r.put('/services/:name', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{ team?: string; criticality?: string }>()
      .catch(() => ({}) as { team?: string; criticality?: string });
    if (body.criticality !== undefined && !CRITICALITY.has(body.criticality)) {
      return c.json({ error: 'criticality must be one of tier1|tier2|tier3' }, 400);
    }
    const service = await upsertService(deps.db, tenantId, {
      name: c.req.param('name'),
      team: body.team ?? null,
      criticality: body.criticality ?? null,
    });
    return c.json({ service });
  });

  r.patch('/services/:name', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{ team?: string | null; criticality?: string | null }>()
      .catch(() => ({}) as Record<string, never>);
    if (
      body.criticality !== undefined &&
      body.criticality !== null &&
      !CRITICALITY.has(body.criticality)
    ) {
      return c.json({ error: 'criticality must be one of tier1|tier2|tier3' }, 400);
    }
    if (!('team' in body) && !('criticality' in body)) {
      return c.json({ error: 'provide at least one of team, criticality' }, 400);
    }
    const service = await updateService(deps.db, tenantId, c.req.param('name'), body);
    if (!service) return c.json({ error: 'service not found' }, 404);
    return c.json({ service });
  });

  r.delete('/services/:name', async (c) => {
    const { tenantId } = c.get('tenant');
    try {
      await deleteService(deps.db, tenantId, c.req.param('name'));
    } catch (e) {
      // A dependency still references the service (FK RESTRICT); surface a 409, not the raw DB error.
      // Any non-FK error propagates so Hono returns a 500 (not a misleading 409).
      if (isFkViolation(e)) {
        return c.json({ error: 'remove dependencies referencing this service first' }, 409);
      }
      throw e;
    }
    return c.json({ ok: true });
  });

  r.get('/dependencies', async (c) => {
    const { tenantId } = c.get('tenant');
    return c.json({ dependencies: await listDependencies(deps.db, tenantId) });
  });

  r.put('/dependencies', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{
        upstream?: string;
        downstream?: string;
        syncType?: string;
        circuitBreaker?: boolean;
        protocol?: string;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.upstream || !body.downstream) {
      return c.json({ error: 'upstream and downstream are required' }, 400);
    }
    if (body.upstream === body.downstream) {
      return c.json({ error: 'a service cannot depend on itself' }, 400);
    }
    if (body.syncType !== undefined && !SYNC_TYPES.has(body.syncType)) {
      return c.json({ error: 'syncType must be sync or async' }, 400);
    }
    try {
      const dependency = await addDependency(deps.db, tenantId, {
        upstream: body.upstream,
        downstream: body.downstream,
        syncType: body.syncType,
        circuitBreaker: body.circuitBreaker,
        protocol: body.protocol ?? null,
      });
      return c.json({ dependency });
    } catch (e) {
      // The composite FK rejects an edge referencing an unregistered service; 400, never the raw DB
      // error (CWE-209). Any non-FK error propagates so Hono returns a 500.
      if (isFkViolation(e)) {
        return c.json({ error: 'both upstream and downstream must be registered services' }, 400);
      }
      throw e;
    }
  });

  r.patch('/dependencies', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{
        upstream?: string;
        downstream?: string;
        syncType?: string;
        circuitBreaker?: boolean;
        protocol?: string | null;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.upstream || !body.downstream) {
      return c.json({ error: 'upstream and downstream are required to identify the edge' }, 400);
    }
    if (body.syncType !== undefined && !SYNC_TYPES.has(body.syncType)) {
      return c.json({ error: 'syncType must be sync or async' }, 400);
    }
    if (!('syncType' in body) && !('circuitBreaker' in body) && !('protocol' in body)) {
      return c.json({ error: 'provide at least one of syncType, circuitBreaker, protocol' }, 400);
    }
    const patch = {
      ...('syncType' in body ? { syncType: body.syncType } : {}),
      ...('circuitBreaker' in body ? { circuitBreaker: body.circuitBreaker } : {}),
      ...('protocol' in body ? { protocol: body.protocol } : {}),
    };
    const dependency = await updateDependency(
      deps.db,
      tenantId,
      body.upstream,
      body.downstream,
      patch,
    );
    if (!dependency) return c.json({ error: 'dependency not found' }, 404);
    return c.json({ dependency });
  });

  r.delete('/dependencies', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{ upstream?: string; downstream?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.upstream || !body.downstream) {
      return c.json({ error: 'upstream and downstream are required' }, 400);
    }
    await removeDependency(deps.db, tenantId, body.upstream, body.downstream);
    return c.json({ ok: true });
  });

  return r;
}
