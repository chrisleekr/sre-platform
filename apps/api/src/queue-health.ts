import { Hono } from 'hono';
import * as z from 'zod';
import type { DeadJobPage } from '@sre/contracts';
import { listDeadJobs, readQueueHealth, type Db, type DeadJobCursor } from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';

const DEAD_PAGE_MAX = 50;

const cursorShape = z.object({
  updatedAt: z
    .string()
    .max(64)
    .refine((value) => Number.isFinite(Date.parse(value))),
  id: z.uuid(),
});

const deadQuery = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(DEAD_PAGE_MAX).default(DEAD_PAGE_MAX),
});

function encodeCursor(cursor: DeadJobCursor | null): string | null {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
}

function decodeCursor(value: string): DeadJobCursor | null {
  try {
    const parsed = cursorShape.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Builds the tenant's read-only work-queue routes. Nothing here retries or edits a job: a retry
 * belongs to the incident page, where it re-checks the incident version and records who asked.
 *
 * @param deps - Authentication collaborators and the app-role database connection.
 */
export function queueHealthRoutes(deps: { auth: AuthDeps; db: Db }) {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  app.get('/health', async (c) => c.json(await readQueueHealth(deps.db, c.get('tenant').tenantId)));
  app.get('/dead', async (c) => {
    const query = deadQuery.safeParse({
      cursor: c.req.query('cursor'),
      limit: c.req.query('limit'),
    });
    if (!query.success) return c.json({ error: 'invalid query' }, 400);
    const cursor = query.data.cursor === undefined ? undefined : decodeCursor(query.data.cursor);
    if (cursor === null) return c.json({ error: 'invalid cursor' }, 400);
    const page = await listDeadJobs(deps.db, c.get('tenant').tenantId, {
      limit: query.data.limit,
      ...(cursor ? { cursor } : {}),
    });
    return c.json({
      jobs: page.jobs,
      nextCursor: encodeCursor(page.nextCursor),
    } satisfies DeadJobPage);
  });
  return app;
}
