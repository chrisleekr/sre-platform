import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { authMiddleware, type TenantAuthVariables } from './auth';
import { registerIncidentAuditRoutes } from './incidents/audit';
import { registerIncidentDetailRoutes } from './incidents/detail';
import { registerIncidentFeedbackRoutes } from './incidents/feedback';
import { registerIncidentLifecycleRoutes } from './incidents/lifecycle';
import { registerIncidentListRoutes } from './incidents/list';
import { registerIncidentPostmortemRoutes } from './incidents/postmortem';
import { registerPostmortemActionItemRoutes } from './incidents/postmortem-action-items';
import { registerIncidentRelationshipRoutes } from './incidents/relationships';
import {
  MAX_ACTIVE_LOOKUP_BODY_BYTES,
  MAX_DECLARATION_BODY_BYTES,
  MAX_ENTITY_MAPPING_BODY_BYTES,
  MAX_FEEDBACK_BODY_BYTES,
  MAX_POSTMORTEM_BODY_BYTES,
  MAX_RELATIONSHIP_BODY_BYTES,
  type IncidentRouteDeps,
} from './incidents/support';

export type { IncidentRouteDeps } from './incidents/support';

/** Registers tenant-scoped incident reads and commands. */
export function incidentRoutes(deps: IncidentRouteDeps): Hono<{ Variables: TenantAuthVariables }> {
  const app = new Hono<{ Variables: TenantAuthVariables }>();
  app.use('*', authMiddleware(deps.auth));
  app.use(
    '/from-observation',
    bodyLimit({
      maxSize: MAX_DECLARATION_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );
  app.use(
    '/observation-workspaces',
    bodyLimit({
      maxSize: MAX_ACTIVE_LOOKUP_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );
  app.use(
    '/:id/feedback',
    bodyLimit({
      maxSize: MAX_FEEDBACK_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );
  app.use(
    '/:id/entity-mapping',
    bodyLimit({
      maxSize: MAX_ENTITY_MAPPING_BODY_BYTES,
      onError: (c) => c.json({ error: 'payload too large' }, 413),
    }),
  );
  for (const path of ['/:id/merge', '/:id/split', '/:id/unrelated'])
    app.use(
      path,
      bodyLimit({
        maxSize: MAX_RELATIONSHIP_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload too large' }, 413),
      }),
    );
  for (const path of ['/:id/postmortem', '/:id/postmortem/*'])
    app.use(
      path,
      bodyLimit({
        maxSize: MAX_POSTMORTEM_BODY_BYTES,
        onError: (c) => c.json({ error: 'payload too large' }, 413),
      }),
    );

  registerIncidentListRoutes(app, deps);
  registerIncidentDetailRoutes(app, deps);
  registerIncidentFeedbackRoutes(app, deps);
  registerIncidentLifecycleRoutes(app, deps);
  registerIncidentRelationshipRoutes(app, deps);
  registerIncidentAuditRoutes(app, deps);
  registerIncidentPostmortemRoutes(app, deps);
  registerPostmortemActionItemRoutes(app, deps);
  return app;
}
