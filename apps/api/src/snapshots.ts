import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import {
  coerceDeployStatus,
  DEPLOY_STATUSES,
  type DeployStatus,
  type NormalizedSnapshot,
} from '@sre/connectors';
import type { SnapshotCache } from '@sre/queue';
import {
  listDeploymentsPage,
  deploymentSummary,
  recentDeploys,
  connectorConfigs,
  withTenant,
  type Db,
  type DeploymentPageCursor,
  type DeploymentFilters,
  type DeployRow,
} from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';

/** Newest-first deploys returned by GET /deployments (the panel shows recent activity). */
const DEPLOYMENTS_LIMIT = 20;

export interface SnapshotRouteDeps {
  auth: AuthDeps;
  cache: SnapshotCache;
  /** RLS-scoped (app_user) connection: GET /deployments reads the durable `deployments` table. */
  db: Db;
}

export interface InfraContainerDto {
  name?: string;
  ready: boolean;
  restartCount: number;
  terminatedReason?: string;
  waitingReason?: string;
  lastTerminatedReason?: string;
  lastTerminatedAt?: string;
}

/** Client InfraSnapshot: tenantId and non-operational connector metadata are dropped. */
export interface InfraSnapshotDto {
  dataSourceId: string;
  dataSourceName: string;
  source: string;
  entityId: string;
  metrics: Record<string, number>;
  observedAt: string;
  error?: string;
  kind?: 'pod' | 'node';
  namespace?: string;
  phase?: string;
  containers?: InfraContainerDto[];
  pressures?: string[];
}

/** Client Deployment: one persisted deploy row reshaped for the dashboard. */
interface DeploymentDto {
  id: string;
  dataSourceId?: string;
  dataSourceName: string;
  source: string;
  providerId?: string;
  repo: string;
  ref: string;
  environment?: string;
  transientEnvironment: boolean;
  actor?: string;
  sha: string;
  revisions?: string[];
  operationPhase?: string;
  service?: string;
  status: DeployStatus;
  deployedAt: string;
  providerCreatedAt?: string;
  providerUpdatedAt?: string;
  url?: string;
  // Advisory error-budget stamp taken when the deploy was persisted. Absent when the service has no
  // objective or none has been evaluated yet. It reports risk; it never gates a deploy.
  budgetRemaining?: number;
  highRisk: boolean;
}

export interface GitOpsApplicationDto {
  dataSourceId: string;
  dataSourceName: string;
  source: 'argocd';
  entityId: string;
  applicationId: string;
  applicationName: string;
  applicationNamespace: string;
  project: string;
  syncStatus?: string;
  healthStatus?: string;
  healthMessage?: string;
  operationPhase?: string;
  operationMessage?: string;
  revisions: string[];
  destinationServer?: string;
  destinationNamespace?: string;
  conditions: Array<{ type?: string; message?: string; lastTransitionTime?: string }>;
  observedAt: string;
  url?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// the deploy-history cursor is opaque to the client — a base64url of the (deployed_at, id) keyset
// pair. Encoding hides the pagination mechanics; decoding fails closed (null → the route 400s) so a
// tampered or truncated cursor never silently returns page one. Mirrors incidents.ts encode/decodeCursor.
function encodeCursor(cursor: DeploymentPageCursor): string {
  return Buffer.from(JSON.stringify({ deployedAt: cursor.deployedAt, id: cursor.id })).toString(
    'base64url',
  );
}
function decodeCursor(raw: string): DeploymentPageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      deployedAt?: unknown;
      id?: unknown;
    };
    if (typeof parsed.deployedAt !== 'string' || typeof parsed.id !== 'string') return null;
    // The id addresses a uuid column: a well-formed cursor carrying a non-UUID id would otherwise reach
    // Postgres and 22P02 (500), contradicting the malformed-cursor→400 contract. Validate it here.
    if (!UUID_RE.test(parsed.id)) return null;
    const deployedAt = new Date(parsed.deployedAt);
    if (Number.isNaN(deployedAt.getTime())) return null;
    return { deployedAt, id: parsed.id };
  } catch {
    return null;
  }
}
// A caller-supplied page size, clamped to a sane cap; anything non-positive/non-integer falls back to the
// repo default. Bounds the work per request so a huge `?limit=` cannot scan the whole history at once.
function parseLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  return Math.min(n, 100);
}

function boundedFilter(raw: string | undefined, max: number): string | undefined | null {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  if (
    !value ||
    value.length > max ||
    Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
  )
    return null;
  return value;
}

function dateFilter(raw: string | undefined): Date | undefined | null {
  if (raw === undefined) return undefined;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function deploymentFilters(query: (name: string) => string | undefined): DeploymentFilters | null {
  const search = boundedFilter(query('search'), 200);
  const service = boundedFilter(query('service'), 200);
  const environment = boundedFilter(query('environment'), 200);
  const source = boundedFilter(query('source'), 64);
  const status = boundedFilter(query('status'), 32);
  const from = dateFilter(query('from'));
  const to = dateFilter(query('to'));
  if ([search, service, environment, source, status, from, to].some((value) => value === null))
    return null;
  if (source && !/^[a-z0-9_-]+$/i.test(source)) return null;
  if (status && !DEPLOY_STATUSES.includes(status.toLowerCase() as DeployStatus)) return null;
  if (from && to && from > to) return null;
  return {
    ...(search ? { search } : {}),
    ...(service ? { service } : {}),
    ...(environment ? { environment } : {}),
    ...(source ? { source: source.toLowerCase() } : {}),
    ...(status ? { status: status.toLowerCase() } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

function metaStr(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function infraContainers(v: unknown): InfraContainerDto[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const containers = v.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const value = item as Record<string, unknown>;
    const lastTerminatedAt = isoOrNull(value.lastTerminatedAt);
    return [
      {
        ...(metaStr(value.name) ? { name: metaStr(value.name) } : {}),
        ready: value.ready === true,
        restartCount:
          typeof value.restartCount === 'number' && Number.isFinite(value.restartCount)
            ? value.restartCount
            : 0,
        ...(metaStr(value.terminatedReason)
          ? { terminatedReason: metaStr(value.terminatedReason) }
          : {}),
        ...(metaStr(value.waitingReason) ? { waitingReason: metaStr(value.waitingReason) } : {}),
        ...(metaStr(value.lastTerminatedReason)
          ? { lastTerminatedReason: metaStr(value.lastTerminatedReason) }
          : {}),
        ...(lastTerminatedAt ? { lastTerminatedAt } : {}),
      },
    ];
  });
  return containers.length > 0 ? containers : undefined;
}

function infraPressures(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const pressures = v.filter((item): item is string => typeof item === 'string' && item.length > 0);
  return pressures.length > 0 ? pressures : undefined;
}

function metaStrings(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function gitOpsConditions(
  value: unknown,
): Array<{ type?: string; message?: string; lastTransitionTime?: string }> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const condition = item as Record<string, unknown>;
    return [
      {
        ...(metaStr(condition.type) ? { type: metaStr(condition.type) } : {}),
        ...(metaStr(condition.message) ? { message: metaStr(condition.message) } : {}),
        ...(metaStr(condition.lastTransitionTime)
          ? { lastTransitionTime: metaStr(condition.lastTransitionTime) }
          : {}),
      },
    ];
  });
}

export function toGitOpsApplication(
  s: NormalizedSnapshot,
  dataSource: { id: string; name: string } = { id: '', name: 'Argo CD' },
): GitOpsApplicationDto | null {
  if (s.source !== 'argocd' || s.metadata.kind !== 'application') return null;
  const applicationId = metaStr(s.metadata.applicationId);
  const applicationName = metaStr(s.metadata.applicationName);
  const applicationNamespace = metaStr(s.metadata.applicationNamespace);
  const project = metaStr(s.metadata.project);
  if (!applicationId || !applicationName || !applicationNamespace || !project) return null;
  return {
    dataSourceId: dataSource.id,
    dataSourceName: dataSource.name,
    source: 'argocd',
    entityId: s.entityId,
    applicationId,
    applicationName,
    applicationNamespace,
    project,
    ...(metaStr(s.metadata.syncStatus) ? { syncStatus: metaStr(s.metadata.syncStatus) } : {}),
    ...(metaStr(s.metadata.healthStatus) ? { healthStatus: metaStr(s.metadata.healthStatus) } : {}),
    ...(metaStr(s.metadata.healthMessage)
      ? { healthMessage: metaStr(s.metadata.healthMessage) }
      : {}),
    ...(metaStr(s.metadata.operationPhase)
      ? { operationPhase: metaStr(s.metadata.operationPhase) }
      : {}),
    ...(metaStr(s.metadata.operationMessage)
      ? { operationMessage: metaStr(s.metadata.operationMessage) }
      : {}),
    revisions: metaStrings(s.metadata.revisions),
    ...(metaStr(s.metadata.destinationServer)
      ? { destinationServer: metaStr(s.metadata.destinationServer) }
      : {}),
    ...(metaStr(s.metadata.destinationNamespace)
      ? { destinationNamespace: metaStr(s.metadata.destinationNamespace) }
      : {}),
    conditions: gitOpsConditions(s.metadata.conditions),
    observedAt: isoOrNull(s.observedAt) ?? new Date().toISOString(),
    ...(metaStr(s.metadata.url) ? { url: metaStr(s.metadata.url) } : {}),
  };
}

/** A valid ISO timestamp from a possibly-malformed value, else undefined — avoids a `toISOString`
 *  RangeError on non-ISO connector data (these values flow in from a tenant's own external API). */
function isoOrNull(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v : v instanceof Date ? v.toISOString() : '';
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function toInfraSnapshot(
  s: NormalizedSnapshot,
  dataSource: { id: string; name: string } = { id: '', name: 'Kubernetes' },
): InfraSnapshotDto {
  const error = metaStr(s.metadata.error);
  const kind =
    s.metadata.kind === 'pod' || s.metadata.kind === 'node' ? s.metadata.kind : undefined;
  const namespace = metaStr(s.metadata.namespace);
  const phase = metaStr(s.metadata.phase);
  const containers = infraContainers(s.metadata.containers);
  const pressures = infraPressures(s.metadata.pressures);
  return {
    dataSourceId: dataSource.id,
    dataSourceName: dataSource.name,
    source: s.source,
    entityId: s.entityId,
    metrics: s.metrics,
    // observedAt arrives from the cache as an ISO string; validate before serializing (an invalid
    // value would otherwise throw a RangeError and 500 the panel).
    observedAt: isoOrNull(s.observedAt) ?? new Date().toISOString(),
    ...(error ? { error } : {}),
    ...(kind ? { kind } : {}),
    ...(namespace ? { namespace } : {}),
    ...(phase ? { phase } : {}),
    ...(containers ? { containers } : {}),
    ...(pressures ? { pressures } : {}),
  };
}

/** Reshape a persisted deploy row into the client Deployment. deployedAt is already normalised by the
 * shared decoder at persist time. Status is coerced onto the DeployStatus union here too,
 *  defensively: rows persisted before the decode-time coercion landed may still carry a raw connector token. */
function toDeployment(r: DeployRow): DeploymentDto {
  return {
    id: r.id,
    ...(r.connectorId ? { dataSourceId: r.connectorId } : {}),
    dataSourceName: r.dataSourceName,
    source: r.source,
    ...(r.providerId ? { providerId: r.providerId } : {}),
    repo: r.repo,
    ref: r.ref ?? '',
    ...(r.environment ? { environment: r.environment } : {}),
    transientEnvironment: r.transientEnvironment,
    ...(r.actor ? { actor: r.actor } : {}),
    sha: r.sha,
    ...(r.revisions && r.revisions.length > 0 ? { revisions: r.revisions } : {}),
    ...(r.operationPhase ? { operationPhase: r.operationPhase } : {}),
    ...(r.service ? { service: r.service } : {}),
    status: coerceDeployStatus(r.status),
    deployedAt: r.deployedAt.toISOString(),
    ...(r.providerCreatedAt ? { providerCreatedAt: r.providerCreatedAt.toISOString() } : {}),
    ...(r.providerUpdatedAt ? { providerUpdatedAt: r.providerUpdatedAt.toISOString() } : {}),
    ...(r.url ? { url: r.url } : {}),
    ...(r.budgetRemaining === null ? {} : { budgetRemaining: r.budgetRemaining }),
    highRisk: r.highRisk,
  };
}

/**
 * Read the poller's cached connector snapshots and persisted deploys for the calling tenant.
 * `GET /infrastructure` serves the infra sources (kubernetes) from the Valkey snapshot cache as
 * InfraSnapshot. `GET /deployments` serves the durable `deployments` table — NOT the snapshot
 * cache — so the panel survives snapshot TTL expiry. Both are strictly tenant-scoped: the cache is
 * keyed by the JWT-resolved tenant, and the deploy read runs under RLS bound to that tenant.
 */
export function snapshotRoutes(deps: SnapshotRouteDeps): Hono<{ Variables: TenantAuthVariables }> {
  const app = new Hono<{ Variables: TenantAuthVariables }>();

  app.get('/infrastructure', authMiddleware(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    const dataSources = await withTenant(deps.db, tenant.tenantId, (tx) =>
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
    );
    const lists = await Promise.all(
      dataSources.map(async (dataSource) => ({
        dataSource,
        snapshots: await deps.cache.get(tenant.tenantId, 'kubernetes', dataSource),
      })),
    );
    const infrastructure = lists.flatMap(({ dataSource, snapshots }) =>
      snapshots.map((snapshot) => toInfraSnapshot(snapshot, dataSource)),
    );
    return c.json({ infrastructure });
  });

  app.get('/gitops', authMiddleware(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    const enabled = await withTenant(deps.db, tenant.tenantId, (tx) =>
      tx
        .select({
          id: connectorConfigs.id,
          name: connectorConfigs.name,
          lifecycleVersion: connectorConfigs.lifecycleVersion,
          verificationSucceededAt: connectorConfigs.verificationSucceededAt,
          pollSucceededAt: connectorConfigs.pollSucceededAt,
        })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.type, 'argocd'),
            eq(connectorConfigs.enabled, true),
            isNull(connectorConfigs.deletedAt),
          ),
        ),
    );
    const current = enabled.filter(
      (dataSource) =>
        dataSource.verificationSucceededAt &&
        dataSource.pollSucceededAt &&
        dataSource.pollSucceededAt >= dataSource.verificationSucceededAt,
    );
    const snapshots = await Promise.all(
      current.map(async (dataSource) => ({
        dataSource,
        snapshots: await deps.cache.get(tenant.tenantId, 'argocd', dataSource),
      })),
    );
    return c.json({
      applications: snapshots.flatMap(({ dataSource, snapshots: sourceSnapshots }) =>
        sourceSnapshots.flatMap((snapshot) => {
          const application = toGitOpsApplication(snapshot, dataSource);
          return application ? [application] : [];
        }),
      ),
    });
  });

  // `GET /deployments` — the calling tenant's deploys, newest first (RLS-scoped). Two shapes:
  // - `?cursor=` / `?limit=`: keyset page over the FULL history; response `{ deployments, nextCursor }`.
  //    `?cursor=` pages older; `?limit=` bounds the page. A malformed cursor is a 400, never a silent page one.
  //  - default: the legacy windowed recent-deploys read (last DEPLOY_WINDOW_DAYS), `{ deployments }`, the
  //    panel's first load. Preserved for existing callers.
  app.get('/deployments', authMiddleware(deps.auth), async (c) => {
    const tenant = c.get('tenant');
    const cursorParam = c.req.query('cursor');
    const limitParam = c.req.query('limit');
    const filters = deploymentFilters((name) => c.req.query(name));
    if (!filters) return c.json({ error: 'invalid deployment filters' }, 400);
    const filtered = Object.keys(filters).length > 0;
    if (cursorParam !== undefined || limitParam !== undefined || filtered) {
      let before: DeploymentPageCursor | undefined;
      if (cursorParam !== undefined) {
        const decoded = decodeCursor(cursorParam);
        if (!decoded) return c.json({ error: 'invalid cursor' }, 400);
        before = decoded;
      }
      const [page, summary] = await Promise.all([
        listDeploymentsPage(deps.db, tenant.tenantId, {
          limit: parseLimit(limitParam),
          before,
          filters,
        }),
        deploymentSummary(deps.db, tenant.tenantId, filters),
      ]);
      return c.json({
        deployments: page.deployments.map(toDeployment),
        nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
        summary: {
          ...summary,
          latestAt: summary.latestAt?.toISOString() ?? null,
        },
      });
    }
    const rows = await recentDeploys(deps.db, tenant.tenantId, { limit: DEPLOYMENTS_LIMIT });
    return c.json({ deployments: rows.map(toDeployment) });
  });

  return app;
}
