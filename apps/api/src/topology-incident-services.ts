import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import {
  incidentServiceAssignments,
  incidents,
  services,
  withTenant,
  recordIncidentFeedbackTx,
  enforceIncidentFeedbackAdmissionTx,
  IncidentFeedbackRateLimitError,
  type Db,
} from '@sre/db';
import { scrubSecrets } from '@sre/agent-tools';
import type { TenantAuthVariables } from './auth';
import { resolveIncidentTopologyContext } from '@sre/topology';

/** Explicit service decisions do not rewrite provider signals or their original entity candidates. */
export function topologyIncidentServiceRoutes(db: Db) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.get('/incidents/:id/context', async (c) => {
    const id = z.uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Choose a valid incident.' }, 400);
    const { tenantId } = c.get('tenant');
    const context = await resolveIncidentTopologyContext(db, tenantId, id.data);
    if (!context) return c.json({ error: 'Incident is unavailable in this workspace.' }, 404);
    return c.json({
      incidentId: id.data,
      topology: context.topology,
      assignedServices: [
        ...new Set(
          context.mappings
            .filter((mapping) => mapping.candidateKey.startsWith('incident-service:'))
            .map((mapping) => mapping.serviceName),
        ),
      ],
    });
  });
  routes.use(
    '*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: 'Service assignment is too large.' }, 413),
    }),
  );
  routes.put('/incidents/:id/services', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('id'));
    const body = z
      .object({
        services: z.array(z.string().trim().min(1).max(200)).max(20),
        rationale: z.string().trim().min(1).max(1000),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success)
      return c.json(
        { error: 'Choose at least one registered service and explain the assignment.' },
        400,
      );
    const { tenantId, userId } = c.get('tenant');
    const names = [...new Set(body.data.services)];
    const rationale = scrubSecrets(body.data.rationale);
    try {
      const result = await withTenant(db, tenantId, async (tx) => {
        const [incident] = await tx
          .select({ id: incidents.id, archivedAt: incidents.archivedAt })
          .from(incidents)
          .where(eq(incidents.id, id.data))
          .for('update');
        if (!incident || incident.archivedAt) return false;
        const catalog = await tx
          .select({ name: services.name })
          .from(services)
          .where(inArray(services.name, names));
        if (catalog.length !== names.length) return false;
        await enforceIncidentFeedbackAdmissionTx(tx, tenantId, userId);
        await tx
          .delete(incidentServiceAssignments)
          .where(eq(incidentServiceAssignments.incidentId, id.data));
        if (names.length)
          await tx.insert(incidentServiceAssignments).values(
            names.map((serviceName) => ({
              tenantId,
              incidentId: id.data,
              serviceName,
              confirmedByUserId: userId,
              rationale,
            })),
          );
        await recordIncidentFeedbackTx(tx, tenantId, id.data, {
          targetType: 'entity',
          targetId: `incident-services:${id.data}`,
          decision: 'correct',
          rationale,
          correction: { services: names },
          createdByUserId: userId,
        });
        return true;
      });
      return result
        ? c.json({ ok: true })
        : c.json(
            { error: 'Incident or registered service is unavailable in this workspace.' },
            404,
          );
    } catch (error) {
      if (error instanceof IncidentFeedbackRateLimitError)
        return c.json({ error: error.message }, 429);
      throw error;
    }
  });
  return routes;
}
