// Incident attachment routes. Two authenticated, RLS-scoped endpoints for
// the dashboard: list an incident's attachment metadata, and proxy one file's bytes (the dashboard
// never sees a raw Slack url_private — the bot token stays server-side). No bytes are persisted; the
// proxy streams them through from Slack via the host-pinned, size-capped fetcher.
import { Hono } from 'hono';
import { attachmentsForIncident, attachmentByFileId, getIncidentSummary, type Db } from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from '../auth';

/** Fetch a file's transient bytes (the shape makeSlackFileFetcher.fetch returns). */
export type AttachmentFetcher = (
  tenantId: string,
  urlPrivate: string,
) => Promise<{ bytes: ArrayBuffer; contentType: string }>;

export interface AttachmentRouteDeps {
  auth: AuthDeps;
  /** RLS-scoped (app_user) connection. */
  db: Db;
  /**
   * Fetch a Slack file's transient bytes (host-pinned + size-capped). Optional so suites that only
   * exercise the list route need not wire it; the download route returns 503 when it is absent.
   */
  fetchAttachment?: AttachmentFetcher;
  /** Max concurrent upstream file fetches (self-throttle vs Slack rate limits). Default 4. */
  fetchConcurrency?: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only these image types are ever served INLINE. Everything else (including image/svg+xml, which can
// carry script and is a stored-XSS vector) is forced to a download with a non-executable content type.
const INLINE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** Strip anything but a safe filename charset so the value cannot break out of the header. */
function safeFilename(name: string): string {
  const cleaned = name.replace(/[^\w.\- ]+/g, '_').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : 'attachment';
}

/**
 * A tiny concurrency gate: at most `max` upstream fetches run at once, the rest queue. A scroll burst
 * that lazy-loads many images therefore cannot fan out into N simultaneous Slack calls and trip its
 * rate limiter. In-process per router instance — good enough for one API replica's self-throttle.
 */
function makeLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiters.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

export function attachmentRoutes(
  deps: AttachmentRouteDeps,
): Hono<{ Variables: TenantAuthVariables }> {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  const limit = makeLimiter(deps.fetchConcurrency ?? 4);

  // `GET /incidents/:id/attachments` — metadata only (never bytes), RLS-scoped to the caller's tenant.
  app.get('/:id/attachments', async (c) => {
    const { tenantId } = c.get('tenant');
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'incident not found' }, 404);
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'incident not found' }, 404);
    const attachments = await attachmentsForIncident(deps.db, tenantId, id);
    return c.json({ attachments });
  });

  // `GET /incidents/:id/attachments/:fileId[?download=1]` — proxy the file's bytes. The lookup is
  // tenant-scoped (RLS), so a cross-tenant file resolves to null → 404, never a leak.
  app.get('/:id/attachments/:fileId', async (c) => {
    if (!deps.fetchAttachment) return c.json({ error: 'attachment proxy not configured' }, 503);
    const { tenantId } = c.get('tenant');
    const id = c.req.param('id');
    const fileId = c.req.param('fileId');
    if (!UUID_RE.test(id)) return c.json({ error: 'attachment not found' }, 404);
    if (!(await getIncidentSummary(deps.db, tenantId, id)))
      return c.json({ error: 'attachment not found' }, 404);

    const row = await attachmentByFileId(deps.db, tenantId, fileId);
    // 404 on: unknown/cross-tenant file (RLS null), or a file that belongs to a different incident.
    if (!row || row.incidentId !== id) return c.json({ error: 'attachment not found' }, 404);

    const download = c.req.query('download') != null && c.req.query('download') !== '0';
    const inline = !download && INLINE_IMAGE_TYPES.has(row.mimetype);
    const filename = safeFilename(row.name);
    // Stable per-file ETag: the bytes behind a Slack file id are immutable, so a re-render can 304.
    const etag = `"${fileId}"`;
    const headers: Record<string, string> = {
      // nosniff: the browser must honor our Content-Type and never sniff an inline type onto a download.
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=3600',
      etag,
      'content-disposition': inline
        ? `inline; filename="${filename}"`
        : `attachment; filename="${filename}"`,
    };

    // Conditional GET: a scroll re-render revalidates cheaply and never hits Slack again.
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);

    let bytes: ArrayBuffer;
    try {
      ({ bytes } = await limit(() => deps.fetchAttachment!(tenantId, row.urlPrivate)));
    } catch {
      // Fixed message: no upstream error text reaches the client (CWE-209). A bad gateway is honest.
      return c.json({ error: 'attachment fetch failed' }, 502);
    }
    // Inline serves the allowlisted image type; everything else (incl. SVG) is octet-stream + attachment.
    headers['content-type'] = inline ? row.mimetype : 'application/octet-stream';
    return c.body(bytes, 200, headers);
  });

  return app;
}
