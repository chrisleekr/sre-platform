import { Hono } from 'hono';
import * as z from 'zod';
import { deleteKnowledgeFact, listKnowledgeFacts, type Db } from '@sre/db';
import {
  authMiddleware,
  refuseImpersonatedChange,
  type AuthDeps,
  type TenantAuthVariables,
} from './auth';
import { UUID_RE } from './incidents/support';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/**
 * Review routes for the facts incidents saved to shared memory. Facts steer later investigations,
 * so the workspace must be able to see each one and remove a wrong one.
 *
 * @param deps - Identity verification and the RLS-scoped connection.
 */
export function knowledgeFactRoutes(deps: { auth: AuthDeps; db: Db }) {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  // A support session looks at the workspace; it does not edit what the workspace has learned.
  app.use('*', refuseImpersonatedChange());

  app.get('/facts', async (c) => {
    const query = listQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'invalid limit' }, 400);
    return c.json({
      facts: await listKnowledgeFacts(deps.db, c.get('tenant').tenantId, query.data.limit),
    });
  });

  app.delete('/facts/:id', async (c) => {
    const id = c.req.param('id');
    if (!UUID_RE.test(id)) return c.json({ error: 'fact not found' }, 404);
    const tenant = c.get('tenant');
    const outcome = await deleteKnowledgeFact(deps.db, tenant.tenantId, id, {
      userId: tenant.userId,
      admin: tenant.role === 'owner' || tenant.role === 'admin',
    });
    if (outcome === 'forbidden')
      return c.json({ error: 'An active responder or administrator must delete a fact.' }, 403);
    return outcome === 'deleted' ? c.body(null, 204) : c.json({ error: 'fact not found' }, 404);
  });

  return app;
}
