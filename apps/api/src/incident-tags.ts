import { Hono } from 'hono';
import {
  acceptIncidentTagSuggestion,
  addIncidentTag,
  listIncidentTags,
  listIncidentTagSuggestions,
  listPendingIncidentTagSuggestions,
  listTenantTagLinkRules,
  removeIncidentTag,
  type Db,
} from '@sre/db';
import { authMiddleware, type AuthDeps, type TenantAuthVariables } from './auth';

/** Authenticated incident-tag application, suggestion, and rendering routes. */
export function incidentTagRoutes(deps: { auth: AuthDeps; db: Db }) {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  app.get('/tags/suggestions', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    return c.json({
      suggestions: await listIncidentTagSuggestions(deps.db, tenantId, {
        prefix: c.req.query('prefix'),
        limit: Math.min(50, Number(c.req.query('limit') ?? 20) || 20),
      }),
    });
  });
  app.get('/:id/tags', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    const incidentId = c.req.param('id');
    const [tags, suggestions, linkRules, historySuggestions] = await Promise.all([
      listIncidentTags(deps.db, tenantId, incidentId),
      listPendingIncidentTagSuggestions(deps.db, tenantId, incidentId),
      listTenantTagLinkRules(deps.db, tenantId),
      listIncidentTagSuggestions(deps.db, tenantId, { limit: 20 }),
    ]);
    return c.json({ tags, suggestions, linkRules, historySuggestions });
  });
  app.post('/:id/tags', async (c) => {
    const tenant = c.get('tenant');
    if (!tenant.userId) return c.json({ error: 'member attribution unavailable' }, 403);
    const body = (await c.req.json().catch(() => null)) as { tag?: unknown } | null;
    if (typeof body?.tag !== 'string') return c.json({ error: 'tag is required' }, 400);
    try {
      return c.json(
        {
          tag: await addIncidentTag(deps.db, tenant.tenantId, {
            incidentId: c.req.param('id'),
            tag: body.tag,
            actorUserId: tenant.userId,
            source: 'dashboard',
          }),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid tag' }, 400);
    }
  });
  app.delete('/:id/tags/:tagId', async (c) => {
    const tenantId = c.get('tenant').tenantId;
    return (await removeIncidentTag(deps.db, tenantId, c.req.param('id'), c.req.param('tagId')))
      ? c.body(null, 204)
      : c.json({ error: 'tag not found' }, 404);
  });
  app.post('/:id/tag-suggestions/:suggestionId/accept', async (c) => {
    const tenant = c.get('tenant');
    if (!tenant.userId) return c.json({ error: 'member attribution unavailable' }, 403);
    const body = (await c.req.json().catch(() => null)) as { tag?: unknown } | null;
    if (typeof body?.tag !== 'string') return c.json({ error: 'tag is required' }, 400);
    try {
      const tag = await acceptIncidentTagSuggestion(deps.db, tenant.tenantId, {
        incidentId: c.req.param('id'),
        suggestionId: c.req.param('suggestionId'),
        tag: body.tag,
        actorUserId: tenant.userId,
        source: 'dashboard',
      });
      return tag ? c.json({ tag }) : c.json({ error: 'suggestion not found' }, 404);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'invalid tag' }, 400);
    }
  });
  return app;
}
