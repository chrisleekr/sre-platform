import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { z } from 'zod';
import {
  decideIssueAction,
  issueDraftSchema,
  listIssueActions,
  prepareIssueAction,
  publicIssueData,
  type IssueActionDeps,
} from '@sre/agent-tools';
import { IssueRequestError } from '@sre/connectors';
import { getIncident } from '@sre/db';
import type { TenantAuthVariables } from '../auth';
import type { IncidentRouteDeps } from './support';
import { UUID_RE } from './support';

/** Incident-scoped issue reads and confirmed changes, using authenticated requester identity.
 * @param parent - Authenticated incident router.
 * @param deps - Existing incident dependencies.
 */
export function registerIncidentIssueRoutes(
  parent: Hono<{ Variables: TenantAuthVariables }>,
  deps: IncidentRouteDeps,
): void {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.onError((error, c) => {
    if (error instanceof IssueRequestError) return c.json({ error: error.message }, 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ error: 'Invalid issue request. Check the target, title and fields.' }, 400);
    return c.json(
      { error: 'Issue management is unavailable. Refresh the result before repeating a change.' },
      503,
    );
  });
  app.use(
    '/:id/issues/*',
    bodyLimit({
      maxSize: 32 * 1024,
      onError: (c) => c.json({ error: 'issue request is too large' }, 413),
    }),
  );
  const service = (): IssueActionDeps | null =>
    deps.hub && deps.resolveConnectors
      ? { db: deps.db, hub: deps.hub, resolveConnectors: deps.resolveConnectors }
      : null;
  app.use('/:id/issues/*', async (c, next) => {
    if (!UUID_RE.test(c.req.param('id') ?? ''))
      return c.json({ error: 'invalid incident ID' }, 400);
    if (!(await getIncident(deps.db, c.get('tenant').tenantId, c.req.param('id')!)))
      return c.json({ error: 'incident not found' }, 404);
    await next();
  });
  app.get('/:id/issues/sources', async (c) => {
    if (!deps.resolveConnectors) return c.json({ error: 'issue connections unavailable' }, 503);
    const sources = await deps.resolveConnectors(c.get('tenant').tenantId);
    return c.json(
      sources
        .filter((source) => source.issues)
        .map((source) => ({ id: source.id, name: source.name, type: source.type })),
    );
  });
  app.get('/:id/issues/repositories', async (c) => {
    const sources = await deps.resolveConnectors?.(c.get('tenant').tenantId);
    const source = sources?.find((item) => item.id === c.req.query('connectorId'));
    if (!source?.issues) return c.json({ error: 'issue connection unavailable' }, 404);
    return c.json(
      publicIssueData(await source.issues.repositories((c.req.query('query') ?? '').slice(0, 255))),
    );
  });
  app.get('/:id/issues/list', async (c) => {
    const sources = await deps.resolveConnectors?.(c.get('tenant').tenantId);
    const source = sources?.find((item) => item.id === c.req.query('connectorId'));
    if (!source?.issues) return c.json({ error: 'issue connection unavailable' }, 404);
    const repository = c.req.query('repository') ?? '';
    const number = c.req.query('number');
    return c.json(
      publicIssueData(
        number !== undefined
          ? await source.issues.get(repository, Number(number))
          : await source.issues.list(
              repository,
              (c.req.query('query') ?? '').slice(0, 255),
              c.req.query('state') === 'closed' ? 'closed' : 'open',
            ),
      ),
    );
  });
  app.get('/:id/issues/actions', async (c) => {
    const actor = c.get('tenant');
    return c.json(
      (await listIssueActions(deps, actor.tenantId, c.req.param('id'))).map((row) => ({
        ...row,
        canConfirm:
          !actor.impersonation &&
          row.requestedBy === actor.userId &&
          row.status === 'draft' &&
          Date.parse(row.expiresAt) > Date.now(),
      })),
    );
  });
  app.post('/:id/issues/drafts', async (c) => {
    const ready = service();
    if (!ready) return c.json({ error: 'issue management is not configured' }, 503);
    const { tenantId, userId } = c.get('tenant');
    const body = z
      .object({ requestId: z.uuid(), draft: issueDraftSchema })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await prepareIssueAction(
        ready,
        tenantId,
        c.req.param('id'),
        userId,
        body.requestId,
        body.draft,
      ),
    );
  });
  app.post('/:id/issues/actions/:actionId', async (c) => {
    const ready = service();
    if (!ready) return c.json({ error: 'issue management is not configured' }, 503);
    const { tenantId, userId } = c.get('tenant');
    const id = z.uuid().parse(c.req.param('actionId'));
    const body = z
      .object({ decision: z.enum(['confirm', 'cancel']) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await decideIssueAction(ready, tenantId, c.req.param('id'), userId, id, body.decision),
    );
  });
  parent.route('/', app);
}
