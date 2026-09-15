import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { scrubSecrets } from '@sre/agent-tools';
import { connectorConfigs, serviceRuntimeBindings, services, withTenant, type Db } from '@sre/db';
import type { TenantAuthVariables } from './auth';

const text = z.string().trim().min(1).max(200);
const binding = z
  .object({
    serviceName: text,
    createService: z.boolean().default(false),
    replaceExisting: z.boolean().default(false),
    connectorId: z.string().uuid(),
    namespace: text,
    labelKey: z
      .enum([
        '',
        'app.kubernetes.io/name',
        'app.kubernetes.io/instance',
        'app.kubernetes.io/component',
        'app',
      ])
      .default(''),
    labelValue: z.string().trim().max(63).default(''),
    environment: text,
    rationale: z.string().trim().min(1).max(1000),
  })
  .refine(
    (value) => !!value.labelKey === !!value.labelValue,
    'Provide both a label key and value, or select the whole namespace.',
  );

/** Mounted under the authenticated topology router. */
export function topologyBindingRoutes(db: Db) {
  const routes = new Hono<{ Variables: TenantAuthVariables }>();
  routes.use(
    '*',
    bodyLimit({
      maxSize: 8192,
      onError: (c) => c.json({ error: 'Runtime mapping is too large.' }, 413),
    }),
  );
  routes.put('/runtime-bindings', async (c) => {
    const parsed = binding.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues.map((issue) => issue.message).join('; ') }, 400);
    const { tenantId, userId } = c.get('tenant');
    const { createService, replaceExisting, ...input } = parsed.data;
    input.rationale = scrubSecrets(input.rationale);
    const result = await withTenant(db, tenantId, async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:runtime-mapping`}, 0))`,
      );
      const [existing] = await tx
        .select({ serviceName: serviceRuntimeBindings.serviceName })
        .from(serviceRuntimeBindings)
        .where(
          and(
            eq(serviceRuntimeBindings.connectorId, input.connectorId),
            eq(serviceRuntimeBindings.namespace, input.namespace),
            eq(serviceRuntimeBindings.labelKey, input.labelKey),
            eq(serviceRuntimeBindings.labelValue, input.labelValue),
          ),
        );
      if (existing && existing.serviceName !== input.serviceName && !replaceExisting)
        return 'conflict' as const;
      const [service] = await tx
        .select({ name: services.name })
        .from(services)
        .where(eq(services.name, input.serviceName));
      const [connector] = await tx
        .select({ id: connectorConfigs.id })
        .from(connectorConfigs)
        .where(
          and(
            eq(connectorConfigs.id, input.connectorId),
            eq(connectorConfigs.type, 'kubernetes'),
            eq(connectorConfigs.enabled, true),
            isNull(connectorConfigs.deletedAt),
          ),
        );
      if (!connector || (!service && !createService)) return null;
      if (!service)
        await tx
          .insert(services)
          .values({ tenantId, name: input.serviceName })
          .onConflictDoNothing();
      const [saved] = await tx
        .insert(serviceRuntimeBindings)
        .values({ ...input, tenantId, confirmedByUserId: userId })
        .onConflictDoUpdate({
          target: [
            serviceRuntimeBindings.tenantId,
            serviceRuntimeBindings.connectorId,
            serviceRuntimeBindings.namespace,
            serviceRuntimeBindings.labelKey,
            serviceRuntimeBindings.labelValue,
          ],
          set: {
            serviceName: input.serviceName,
            environment: input.environment,
            rationale: input.rationale,
            confirmedByUserId: userId,
            updatedAt: new Date(),
          },
        })
        .returning();
      return saved;
    });
    if (result === 'conflict')
      return c.json(
        {
          error:
            'This runtime selector is already linked to another service. Use Edit mapping to explicitly reassign it.',
        },
        409,
      );
    return result
      ? c.json({ binding: result })
      : c.json(
          {
            error:
              'Select a registered service and an active Kubernetes connection in this workspace.',
          },
          400,
        );
  });
  routes.delete('/runtime-bindings/:id', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('id'));
    if (!id.success) return c.json({ error: 'Invalid runtime binding ID.' }, 400);
    const { tenantId } = c.get('tenant');
    const removed = await withTenant(db, tenantId, (tx) =>
      tx
        .delete(serviceRuntimeBindings)
        .where(eq(serviceRuntimeBindings.id, id.data))
        .returning({ id: serviceRuntimeBindings.id }),
    );
    if (!removed.length)
      return c.json({ error: 'This runtime mapping is unavailable in this workspace.' }, 404);
    return c.json({ ok: true });
  });
  return routes;
}
