import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { scrubSecrets } from '@sre/agent-tools';
import { z } from 'zod';
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
  listTopologyIncidentServices,
  connectorConfigs,
  serviceRuntimeBindings,
  withTenant,
  type Db,
  type DeployRow,
} from '@sre/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { SnapshotCache } from '@sre/queue';
import {
  computeBlastRadius,
  readDiscoveredTopology,
  readTopologyRuntime,
  readTopologyEndpointEvidence,
} from '@sre/topology';
import {
  authMiddleware,
  requireTenantConfigurationAdmin,
  type AuthDeps,
  type TenantAuthVariables,
} from './auth';
import { toInfraSnapshot } from './snapshots';
import { topologyCoverage } from './topology-coverage';
import { topologyBindingRoutes } from './topology-bindings';
import { topologyReliabilityRoutes } from './topology-reliability';
import { topologyIncidentServiceRoutes } from './topology-incident-services';
import {
  readTopologyDeclarationSnapshot,
  readTopologyDeclarationChanges,
} from './topology-history';

export interface TopologyRoutesDeps {
  auth: AuthDeps;
  /** RLS-scoped (app_user) connection. */
  db: Db;
  /** Generation-aware runtime observations for catalog and discovered resource reads. */
  cache: SnapshotCache;
}

const SYNC_TYPES = new Set(['sync', 'async']);
const CRITICALITY = new Set(['tier1', 'tier2', 'tier3']);
const serviceFields = z.object({
  team: z.string().nullable().optional(),
  criticality: z.enum(['tier1', 'tier2', 'tier3']).nullable().optional(),
});
const serviceName = z
  .string()
  .refine(
    (name) => name.length > 0 && name.trim() === name,
    'Use a non-empty service name without surrounding spaces.',
  );
const dependencyFields = z.object({
  upstream: serviceName,
  downstream: serviceName,
  syncType: z.enum(['sync', 'async']).optional(),
  circuitBreaker: z.boolean().optional(),
  protocol: z.string().nullable().optional(),
  environment: z.string().trim().max(200).optional(),
  rationale: z.string().trim().max(1000).nullable().optional(),
});

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
 * Tenant-scoped topology reads are available to members. Durable catalog, binding and incident
 * assignment corrections require a workspace owner or administrator. Discovery remains distinct
 * from human declarations.
 */
export function topologyRoutes(deps: TopologyRoutesDeps): Hono<{ Variables: TenantAuthVariables }> {
  const r = new Hono<{ Variables: TenantAuthVariables }>();
  r.use('*', authMiddleware(deps.auth));
  r.use('*', requireTenantConfigurationAdmin());
  r.use(
    '*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: 'Topology update is too large.' }, 413),
    }),
  );
  r.route('/', topologyBindingRoutes(deps.db));
  r.route('/', topologyReliabilityRoutes(deps.db));
  r.route('/', topologyIncidentServiceRoutes(deps.db));
  r.use('/services/:name', async (c, next) => {
    if (!serviceName.safeParse(c.req.param('name')).success)
      return c.json({ error: 'Use a non-empty service name without surrounding spaces.' }, 400);
    if (c.req.method === 'PUT' || c.req.method === 'PATCH') {
      const result = serviceFields.safeParse(await c.req.json().catch(() => null));
      if (!result.success)
        return c.json(
          {
            error: result.error.issues
              .map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`)
              .join('; '),
          },
          400,
        );
    }
    return next();
  });
  r.use('/dependencies', async (c, next) => {
    if (['PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
      const result = dependencyFields.safeParse(await c.req.json().catch(() => null));
      if (!result.success)
        return c.json(
          {
            error: result.error.issues
              .map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`)
              .join('; '),
          },
          400,
        );
    }
    return next();
  });

  r.get('/services', async (c) => {
    const { tenantId } = c.get('tenant');
    return c.json({ services: await listServices(deps.db, tenantId) });
  });

  // Compose the operational inventory from the durable catalog plus live, attributable signals. Only
  // service-to-service edges remain manual: pod co-location is not evidence that one service calls another.
  r.get('/graph', async (c) => {
    const { tenantId } = c.get('tenant');
    const at = c.req.query('at');
    if (at && (!Number.isFinite(Date.parse(at)) || Date.parse(at) > Date.now()))
      return c.json({ error: 'Select a valid past time for declaration history.' }, 400);
    if (at)
      return c.json(
        await readTopologyDeclarationSnapshot(
          deps.db,
          tenantId,
          new Date(Date.parse(at)).toISOString(),
        ),
      );
    const [
      svcs,
      dependencies,
      deploys,
      incidentMappings,
      kubernetesSources,
      runtimeBindings,
      discovery,
    ] = await Promise.all([
      listServices(deps.db, tenantId),
      listDependencies(deps.db, tenantId),
      recentDeploys(deps.db, tenantId, { perService: 5 }),
      listTopologyIncidentServices(deps.db, tenantId),
      withTenant(deps.db, tenantId, (tx) =>
        tx
          .select({
            id: connectorConfigs.id,
            name: connectorConfigs.name,
            lifecycleVersion: connectorConfigs.lifecycleVersion,
            pollSucceededAt: connectorConfigs.pollSucceededAt,
            pollFailureCategory: connectorConfigs.pollFailureCategory,
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
      withTenant(deps.db, tenantId, (tx) => tx.select().from(serviceRuntimeBindings)),
      readDiscoveredTopology(deps.db, tenantId),
    ]);
    const collections = await Promise.all(
      kubernetesSources.map(async (dataSource) => ({
        dataSource,
        snapshots: await deps.cache.get(tenantId, 'kubernetes', dataSource),
      })),
    );
    const coverage = collections.map(({ dataSource, snapshots }) =>
      topologyCoverage(dataSource, snapshots),
    );
    const infrastructure = collections.flatMap(({ dataSource, snapshots }) =>
      snapshots
        .filter((snapshot) => snapshot.metadata.kind !== 'collection')
        .flatMap((snapshot) => toInfraSnapshot(snapshot, dataSource) ?? []),
    );
    const incidentServices = new Set(incidentMappings.flatMap((mapping) => mapping.services));
    const kubernetesServices = new Set(runtimeBindings.map((binding) => binding.serviceName));
    const byService = new Map<string, DeployRow[]>();
    for (const d of deploys) {
      if (!d.service) continue;
      const arr = byService.get(d.service);
      if (arr) arr.push(d);
      else byService.set(d.service, [d]);
    }
    const catalogByName = new Map(svcs.map((service) => [service.name, service]));
    const names = new Set(catalogByName.keys());
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
            id: d.id,
            dataSourceId: d.connectorId,
            dataSourceName: d.dataSourceName,
            environment: d.environment,
            source: d.source,
            attribution: 'provider_reported',
            url: d.url,
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
      protocol: d.protocol,
      environment: d.environment,
      rationale: d.rationale,
      confirmedByUserId: d.confirmedByUserId,
      lastConfirmedAt: d.lastConfirmedAt?.toISOString() ?? null,
    }));
    return c.json({
      nodes,
      edges,
      discovery,
      infrastructure,
      coverage,
      runtimeBindings: runtimeBindings.map(({ tenantId: _tenant, ...binding }) => binding),
      incidentMappings: incidentMappings.map(({ incidentId, services }) => ({
        incidentId,
        services,
      })),
      incidents: incidentMappings.map(({ incident }) => ({
        ...incident,
        title: incident.title ? scrubSecrets(incident.title) : null,
      })),
    });
  });

  // On-demand blast radius for a service (incident overlay). Wraps the recursive-CTE query in
  // @sre/topology; RLS-scoped. `mapped: false` in the payload signals a service that isn't a graph node.
  r.get('/blast-radius', async (c) => {
    const { tenantId } = c.get('tenant');
    const service = c.req.query('service');
    if (!service) return c.json({ error: 'service query param is required' }, 400);
    return c.json(
      await computeBlastRadius(deps.db, tenantId, service, {
        environment: c.req.query('environment'),
        subjectKey: c.req.query('subjectKey'),
      }),
    );
  });

  r.get('/runtime', async (c) => {
    const key = c.req.query('subjectKey');
    if (!key || key.length > 8192)
      return c.json({ error: 'A valid topology subjectKey is required.' }, 400);
    const { tenantId } = c.get('tenant');
    return c.json(
      await readTopologyRuntime(deps.db, tenantId, { key }, (tenant, source) =>
        deps.cache.get(tenant, source.type, source),
      ),
    );
  });
  r.get('/endpoint-evidence', async (c) => {
    const key = c.req.query('subjectKey');
    if (!key || key.length > 8192)
      return c.json({ error: 'A valid topology subjectKey is required.' }, 400);
    return c.json(await readTopologyEndpointEvidence(deps.db, c.get('tenant').tenantId, key));
  });

  r.get('/history', async (c) => {
    const { tenantId } = c.get('tenant');
    const rows = await readTopologyDeclarationChanges(deps.db, tenantId);
    return c.json({ changes: rows });
  });

  r.put('/services/:name', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{ team?: string | null; criticality?: string | null }>()
      .catch(() => ({}) as { team?: string | null; criticality?: string | null });
    if (body.criticality != null && !CRITICALITY.has(body.criticality)) {
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
        return c.json(
          {
            error:
              'This service is still referenced by dependencies, runtime mappings or explicit incident assignments. Remove those associations before deleting it.',
          },
          409,
        );
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
        environment?: string;
        rationale?: string | null;
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
        environment: body.environment?.trim() ?? '',
        rationale: body.rationale ? scrubSecrets(body.rationale) : null,
        confirmedByUserId: body.rationale?.trim() ? c.get('tenant').userId : null,
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
        environment?: string;
        rationale?: string | null;
      }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.upstream || !body.downstream) {
      return c.json({ error: 'upstream and downstream are required to identify the edge' }, 400);
    }
    if (body.syncType !== undefined && !SYNC_TYPES.has(body.syncType)) {
      return c.json({ error: 'syncType must be sync or async' }, 400);
    }
    if (
      !('syncType' in body) &&
      !('circuitBreaker' in body) &&
      !('protocol' in body) &&
      !('rationale' in body)
    ) {
      return c.json(
        { error: 'provide at least one of syncType, circuitBreaker, protocol, rationale' },
        400,
      );
    }
    const patch = {
      ...('syncType' in body ? { syncType: body.syncType } : {}),
      ...('circuitBreaker' in body ? { circuitBreaker: body.circuitBreaker } : {}),
      ...('protocol' in body ? { protocol: body.protocol } : {}),
      ...('rationale' in body
        ? {
            rationale: body.rationale ? scrubSecrets(body.rationale) : null,
            confirmedByUserId: body.rationale?.trim() ? c.get('tenant').userId : null,
          }
        : {}),
    };
    const dependency = await updateDependency(
      deps.db,
      tenantId,
      body.upstream,
      body.downstream,
      patch,
      body.environment?.trim() ?? '',
    );
    if (!dependency) return c.json({ error: 'dependency not found' }, 404);
    return c.json({ dependency });
  });

  r.delete('/dependencies', async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req
      .json<{ upstream?: string; downstream?: string; environment?: string }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.upstream || !body.downstream) {
      return c.json({ error: 'upstream and downstream are required' }, 400);
    }
    const removed = await removeDependency(
      deps.db,
      tenantId,
      body.upstream,
      body.downstream,
      body.environment?.trim() ?? '',
    );
    if (!removed) return c.json({ error: 'dependency not found' }, 404);
    return c.json({ ok: true });
  });

  return r;
}
