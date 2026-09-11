import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  createSlo,
  listSlos,
  getSlo,
  updateSlo,
  deleteSlo,
  SloLimitReachedError,
  type Db,
  type NewSlo,
  type SloPatch,
} from '@sre/db';
import { sloDashboard } from '@sre/slo';
import { isConnectorType } from '@sre/connectors';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';
import { UUID_RE } from './incidents/support';

export interface SloRoutesDeps {
  auth: AuthDeps;
  /** RLS-scoped (app_user) connection. */
  db: Db;
}

const SLI_TYPES = new Set(['availability', 'latency']);

// Per-tenant ceiling on objective definitions. A definition store is bounded, not a log: the cap keeps
// the dashboard read and the windowed burn-event fan-out predictable. Raise it deliberately.
// Counted and enforced inside the insert transaction by the repository, not here: counting here and
// inserting afterwards is a read-then-write two concurrent creates can both win.
const MAX_SLOS_PER_TENANT = 100;

// One objective definition is a handful of short fields, so 8 KiB leaves generous headroom over the
// per-field caps below while bounding what an authenticated member can make the API buffer.
const MAX_SLO_BODY_BYTES = 8 * 1024;

// Matches the incident and reliability routers, so a service name means the same length everywhere.
const MAX_SERVICE_LEN = 200;

// An objective name is a short human label and the tenant-unique key, so it needs no more room than
// the service it names.
const MAX_NAME_LEN = 200;

// The stored query is replayed to the tenant's backend twice per objective every five minutes, so its
// length is sustained outbound traffic rather than a one-shot. 2000 characters holds any realistic
// PromQL expression, including recording-rule-free nested aggregations.
const MAX_METRIC_QUERY_LEN = 2_000;

/** Postgres SQLSTATEs these routes translate to a 4xx; any other error propagates to a 500. */
function pgCode(e: unknown): string | undefined {
  // drizzle wraps DB errors, so the postgres.js SQLSTATE is on `.cause.code`; fall back to `.code`.
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code ?? err?.cause?.code;
}

/**
 * Map a write failure to a 4xx, or null to let it propagate. A duplicate name is a 409 and a CHECK
 * backstop a 400, never the raw database text (CWE-209). Any other SQLSTATE propagates so Hono
 * returns a 500 rather than a misleading 4xx.
 */
function writeFailure(e: unknown): { error: string; status: 409 | 400 } | null {
  const code = pgCode(e);
  if (code === '23505') return { error: 'an objective with this name already exists', status: 409 };
  if (code === '23514') return { error: 'invalid objective definition', status: 400 };
  return null;
}

interface SloBody {
  name?: unknown;
  service?: unknown;
  sliType?: unknown;
  target?: unknown;
  windowDays?: unknown;
  thresholdMs?: unknown;
  metricQuery?: unknown;
  connectorType?: unknown;
  enabled?: unknown;
}

// Free text lands in unbounded `text` columns, so every caller passes the field's own ceiling.
function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

// Postgres int4 ceiling: `window_days` and `threshold_ms` are `integer` columns, so an out-of-range
// value is rejected here as a clean 400 rather than reaching the driver as an untranslated overflow.
const INT4_MAX = 2_147_483_647;

function isPosInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= INT4_MAX;
}

/** Validate a full objective definition, returning a message or a typed definition. */
function parseNewSlo(body: SloBody): { error: string } | { slo: NewSlo } {
  if (!isBoundedString(body.name, MAX_NAME_LEN)) {
    return { error: `name is required and must be at most ${MAX_NAME_LEN} characters` };
  }
  if (!isBoundedString(body.service, MAX_SERVICE_LEN)) {
    return { error: `service is required and must be at most ${MAX_SERVICE_LEN} characters` };
  }
  if (typeof body.sliType !== 'string' || !SLI_TYPES.has(body.sliType)) {
    return { error: 'sliType must be availability or latency' };
  }
  if (typeof body.target !== 'number' || !(body.target > 0 && body.target < 1)) {
    return { error: 'target must be a number between 0 and 1 (exclusive)' };
  }
  if (!isPosInt(body.windowDays)) return { error: 'windowDays must be a positive integer' };
  const isLatency = body.sliType === 'latency';
  const hasThreshold = body.thresholdMs !== undefined && body.thresholdMs !== null;
  if (isLatency && !isPosInt(body.thresholdMs)) {
    return { error: 'latency objectives require thresholdMs (a positive integer)' };
  }
  if (!isLatency && hasThreshold) {
    return { error: 'thresholdMs is only valid for latency objectives' };
  }
  if (!isBoundedString(body.metricQuery, MAX_METRIC_QUERY_LEN)) {
    return {
      error: `metricQuery is required and must be at most ${MAX_METRIC_QUERY_LEN} characters`,
    };
  }
  if (typeof body.connectorType !== 'string' || !isConnectorType(body.connectorType)) {
    return { error: 'connectorType must be a known connector type' };
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
    return { error: 'enabled must be a boolean' };
  }
  return {
    slo: {
      name: body.name,
      service: body.service,
      sliType: body.sliType as NewSlo['sliType'],
      target: body.target,
      windowDays: body.windowDays,
      thresholdMs: isLatency ? (body.thresholdMs as number) : null,
      metricQuery: body.metricQuery,
      connectorType: body.connectorType,
      enabled: body.enabled as boolean | undefined,
    },
  };
}

/** Validate a partial update. Cross-field latency consistency is backstopped by the database CHECK. */
function parsePatch(body: SloBody): { error: string } | { patch: SloPatch } {
  const patch: SloPatch = {};
  if (body.name !== undefined) {
    if (!isBoundedString(body.name, MAX_NAME_LEN)) {
      return { error: `name must be a non-empty string of at most ${MAX_NAME_LEN} characters` };
    }
    patch.name = body.name;
  }
  if (body.service !== undefined) {
    if (!isBoundedString(body.service, MAX_SERVICE_LEN)) {
      return {
        error: `service must be a non-empty string of at most ${MAX_SERVICE_LEN} characters`,
      };
    }
    patch.service = body.service;
  }
  if (body.sliType !== undefined) {
    if (typeof body.sliType !== 'string' || !SLI_TYPES.has(body.sliType)) {
      return { error: 'sliType must be availability or latency' };
    }
    patch.sliType = body.sliType as NewSlo['sliType'];
  }
  if (body.target !== undefined) {
    if (typeof body.target !== 'number' || !(body.target > 0 && body.target < 1)) {
      return { error: 'target must be a number between 0 and 1 (exclusive)' };
    }
    patch.target = body.target;
  }
  if (body.windowDays !== undefined) {
    if (!isPosInt(body.windowDays)) return { error: 'windowDays must be a positive integer' };
    patch.windowDays = body.windowDays;
  }
  if (body.thresholdMs !== undefined) {
    if (body.thresholdMs !== null && !isPosInt(body.thresholdMs)) {
      return { error: 'thresholdMs must be a positive integer or null' };
    }
    patch.thresholdMs = body.thresholdMs as number | null;
  }
  if (body.metricQuery !== undefined) {
    if (!isBoundedString(body.metricQuery, MAX_METRIC_QUERY_LEN)) {
      return {
        error: `metricQuery must be a non-empty string of at most ${MAX_METRIC_QUERY_LEN} characters`,
      };
    }
    patch.metricQuery = body.metricQuery;
  }
  if (body.connectorType !== undefined) {
    if (typeof body.connectorType !== 'string' || !isConnectorType(body.connectorType)) {
      return { error: 'connectorType must be a known connector type' };
    }
    patch.connectorType = body.connectorType;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') return { error: 'enabled must be a boolean' };
    patch.enabled = body.enabled;
  }
  return { patch };
}

/**
 * Tenant-facing CRUD for service level objectives, plus the dashboard status read. RLS-scoped; any
 * authenticated tenant member can read and write (flat membership). The scheduled evaluator and the
 * always-bound triage tool read the same definitions. Nothing here opens an incident: an objective is
 * a measurement, and a burning budget is reported rather than acted on.
 */
export function sloRoutes(deps: SloRoutesDeps): Hono<{ Variables: TenantAuthVariables }> {
  const r = new Hono<{ Variables: TenantAuthVariables }>();
  r.use('*', authMiddleware(deps.auth));
  const sloBodyLimit = bodyLimit({
    maxSize: MAX_SLO_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload too large' }, 413),
  });

  r.get('/', async (c) => {
    const { tenantId } = c.get('tenant');
    return c.json({ slos: await listSlos(deps.db, tenantId) });
  });

  // The dashboard read: every objective with its latest evaluation and when that was computed.
  // Registered before '/:id' so 'status' is never captured as an objective id.
  r.get('/status', async (c) => {
    const { tenantId } = c.get('tenant');
    return c.json({ slos: await sloDashboard(deps.db, tenantId) });
  });

  r.get('/:id', async (c) => {
    const { tenantId } = c.get('tenant');
    const id = c.req.param('id');
    // A non-uuid id would make Postgres raise 22P02 (a 500); treat it as not-found before the query.
    if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
    const slo = await getSlo(deps.db, tenantId, id);
    if (!slo) return c.json({ error: 'not found' }, 404);
    return c.json({ slo });
  });

  r.post('/', sloBodyLimit, async (c) => {
    const { tenantId } = c.get('tenant');
    const body = await c.req.json<SloBody>().catch(() => ({}) as SloBody);
    const parsed = parseNewSlo(body);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    try {
      const slo = await createSlo(deps.db, tenantId, parsed.slo, MAX_SLOS_PER_TENANT);
      return c.json({ slo }, 201);
    } catch (e) {
      if (e instanceof SloLimitReachedError) return c.json({ error: e.message }, 400);
      const failure = writeFailure(e);
      if (!failure) throw e;
      return c.json({ error: failure.error }, failure.status);
    }
  });

  r.patch('/:id', sloBodyLimit, async (c) => {
    const { tenantId } = c.get('tenant');
    const id = c.req.param('id');
    // A non-uuid id would make Postgres raise 22P02 (a 500); treat it as not-found before the query.
    if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
    const body = await c.req.json<SloBody>().catch(() => ({}) as SloBody);
    const parsed = parsePatch(body);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    try {
      const slo = await updateSlo(deps.db, tenantId, id, parsed.patch);
      if (!slo) return c.json({ error: 'not found' }, 404);
      return c.json({ slo });
    } catch (e) {
      const failure = writeFailure(e);
      if (!failure) throw e;
      return c.json({ error: failure.error }, failure.status);
    }
  });

  r.delete('/:id', async (c) => {
    const { tenantId } = c.get('tenant');
    const id = c.req.param('id');
    // A non-uuid id would make Postgres raise 22P02 (a 500); treat it as not-found before the query.
    if (!UUID_RE.test(id)) return c.json({ error: 'not found' }, 404);
    const removed = await deleteSlo(deps.db, tenantId, id);
    return removed ? c.body(null, 204) : c.json({ error: 'not found' }, 404);
  });

  return r;
}
