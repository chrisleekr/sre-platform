import { Hono } from 'hono';
import { and, inArray, isNull } from 'drizzle-orm';
import {
  CHANGE_CATEGORIES,
  CHANGE_PROVIDERS,
  changeSummary,
  connectorConfigs,
  listChangesPage,
  withTenant,
  type ChangeCategory,
  type ChangeFilters,
  type ChangePageCursor,
  type ChangeProvider,
  type ChangeRow,
  type Db,
} from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChangeDto {
  id: string;
  provider: ChangeProvider;
  dataSourceId: string | null;
  dataSourceName: string;
  category: ChangeCategory;
  eventType: string;
  action?: string;
  repository?: string;
  actor?: string;
  ref?: string;
  sha?: string;
  title: string;
  status?: string;
  url?: string;
  occurredAt: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function scalar(value: unknown): string | undefined {
  return (
    text(value) ?? (typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined)
  );
}

function titleFor(row: ChangeRow): string {
  const summary = row.summary;
  const head = record(summary.headCommit);
  if (row.eventType === 'tag_push')
    return `Tag ${(row.ref ?? text(summary.ref) ?? 'unknown').replace(/^refs\/tags\//, '')} pushed`;
  if (row.eventType === 'push') {
    const count = typeof summary.commitCount === 'number' ? summary.commitCount : undefined;
    return (
      text(head.message) ??
      (count !== undefined ? `${count} commit${count === 1 ? '' : 's'} pushed` : 'Code pushed')
    );
  }
  return (
    text(summary.title) ??
    text(summary.name) ??
    text(head.message) ??
    (row.eventType === 'pipeline' && scalar(summary.id)
      ? `Pipeline #${scalar(summary.id)}`
      : undefined) ??
    (row.eventType === 'release' && text(summary.tag)
      ? `Release ${text(summary.tag)}`
      : undefined) ??
    row.action ??
    row.eventType.replaceAll('_', ' ')
  );
}

function changeDto(row: ChangeRow): ChangeDto {
  const status =
    text(row.summary.conclusion) ??
    text(row.summary.status) ??
    text(row.summary.state) ??
    (row.category === 'ci' || row.category === 'review' ? (row.action ?? undefined) : undefined);
  const url =
    text(row.summary.htmlUrl) ?? text(row.summary.url) ?? text(record(row.summary.headCommit).url);
  return {
    id: row.id,
    provider: row.provider,
    dataSourceId: row.dataSourceId,
    dataSourceName: row.dataSourceName,
    category: row.category,
    eventType: row.eventType,
    ...(row.action ? { action: row.action } : {}),
    ...(row.repository ? { repository: row.repository } : {}),
    ...(row.actor ? { actor: row.actor } : {}),
    ...(row.ref ? { ref: row.ref } : {}),
    ...(row.sha ? { sha: row.sha } : {}),
    title: titleFor(row),
    ...(status ? { status } : {}),
    ...(url ? { url } : {}),
    occurredAt: row.occurredAt.toISOString(),
  };
}

function encodeCursor(cursor: ChangePageCursor): string {
  return Buffer.from(
    JSON.stringify({
      occurredAt: cursor.occurredAt.toISOString(),
      id: cursor.id,
      provider: cursor.provider,
    }),
  ).toString('base64url');
}

function decodeCursor(raw: string): ChangePageCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.occurredAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      typeof parsed.provider !== 'string' ||
      !UUID_RE.test(parsed.id) ||
      !CHANGE_PROVIDERS.includes(parsed.provider as ChangeProvider)
    )
      return null;
    const occurredAt = new Date(parsed.occurredAt);
    return Number.isNaN(occurredAt.getTime())
      ? null
      : { occurredAt, id: parsed.id, provider: parsed.provider as ChangeProvider };
  } catch {
    return null;
  }
}

function bounded(raw: string | undefined, max: number): string | undefined | null {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  return value &&
    value.length <= max &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 0x20)
    ? value
    : null;
}

function filters(query: (name: string) => string | undefined): ChangeFilters | null {
  const provider = bounded(query('provider'), 16);
  const dataSourceId = bounded(query('dataSourceId'), 36);
  const category = bounded(query('category'), 16);
  const repository = bounded(query('repository'), 300);
  const status = bounded(query('status'), 64);
  const search = bounded(query('search'), 200);
  const fromRaw = query('from');
  const toRaw = query('to');
  const from = fromRaw ? new Date(fromRaw) : undefined;
  const to = toRaw ? new Date(toRaw) : undefined;
  if (
    [provider, dataSourceId, category, repository, status, search].some(
      (value) => value === null,
    ) ||
    (from && Number.isNaN(from.getTime())) ||
    (to && Number.isNaN(to.getTime())) ||
    (from && to && from > to) ||
    (provider && !CHANGE_PROVIDERS.includes(provider as ChangeProvider)) ||
    (dataSourceId && !UUID_RE.test(dataSourceId)) ||
    (category && !CHANGE_CATEGORIES.includes(category as ChangeCategory)) ||
    (status && !/^[a-z0-9_-]+$/i.test(status))
  )
    return null;
  return {
    ...(provider ? { provider: provider as ChangeProvider } : {}),
    ...(dataSourceId ? { dataSourceId } : {}),
    ...(category ? { category: category as ChangeCategory } : {}),
    ...(repository ? { repository } : {}),
    ...(status ? { status } : {}),
    ...(search ? { search } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

export function changeRoutes(deps: { auth: AuthDeps; db: Db }) {
  const router = new Hono<{ Variables: TenantAuthVariables }>();
  router.use('*', authMiddleware(deps.auth));
  router.get('/', async (c) => {
    const { tenantId } = c.get('tenant');
    const parsedFilters = filters((name) => c.req.query(name));
    if (!parsedFilters) return c.json({ error: 'invalid change filters' }, 400);
    const cursorRaw = c.req.query('cursor');
    const before = cursorRaw ? (decodeCursor(cursorRaw) ?? undefined) : undefined;
    if (cursorRaw && !before) return c.json({ error: 'invalid cursor' }, 400);
    const limitRaw = c.req.query('limit');
    const requestedLimit = limitRaw ? Number(limitRaw) : 20;
    if (!Number.isInteger(requestedLimit) || requestedLimit <= 0)
      return c.json({ error: 'invalid limit' }, 400);
    const limit = Math.min(requestedLimit, 100);
    const [page, summary, healthRows] = await Promise.all([
      listChangesPage(deps.db, tenantId, { limit, before, filters: parsedFilters }),
      changeSummary(deps.db, tenantId, parsedFilters),
      withTenant(deps.db, tenantId, (tx) =>
        tx
          .select({
            id: connectorConfigs.id,
            name: connectorConfigs.name,
            provider: connectorConfigs.type,
            enabled: connectorConfigs.enabled,
            lastAttemptAt: connectorConfigs.eventAttemptedAt,
            lastSuccessAt: connectorConfigs.eventSucceededAt,
            count: connectorConfigs.eventCount,
            failureCategory: connectorConfigs.eventFailureCategory,
          })
          .from(connectorConfigs)
          .where(
            and(
              inArray(connectorConfigs.type, ['github', 'gitlab']),
              isNull(connectorConfigs.deletedAt),
            ),
          ),
      ),
    ]);
    return c.json({
      changes: page.changes.map(changeDto),
      nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null,
      summary: {
        ...summary,
        latestAt: summary.latestAt?.toISOString() ?? null,
      },
      sources: healthRows.map((row) => ({
        ...row,
        lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
        lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      })),
    });
  });
  return router;
}
