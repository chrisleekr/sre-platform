import { and, eq, inArray, isNull } from 'drizzle-orm';
import { connectorConfigs, serviceRuntimeBindings, withTenant, type Db } from '@sre/db';
import type { NormalizedSnapshot } from '@sre/connectors';

/**
 * Read only explicitly bound runtime and refuse incomplete evidence for lifecycle decisions.
 *
 * @param db - Tenant-scoped application database.
 * @param tenantId - Workspace owning the service.
 * @param service - Registered logical service name.
 * @param read - Generation-aware snapshot reader supplied by the caller.
 */
export async function readServiceRuntime(
  db: Db,
  tenantId: string,
  service: string,
  read: (source: { id: string; lifecycleVersion: number }) => Promise<NormalizedSnapshot[]>,
): Promise<NormalizedSnapshot[] | null> {
  const { bindings, sources } = await withTenant(db, tenantId, async (tx) => {
    const bindingRows = await tx
      .select()
      .from(serviceRuntimeBindings)
      .where(eq(serviceRuntimeBindings.serviceName, service));
    const ids = [...new Set(bindingRows.map((binding) => binding.connectorId))];
    const sourceRows = ids.length
      ? await tx
          .select()
          .from(connectorConfigs)
          .where(
            and(
              inArray(connectorConfigs.id, ids),
              eq(connectorConfigs.type, 'kubernetes'),
              eq(connectorConfigs.enabled, true),
              isNull(connectorConfigs.deletedAt),
            ),
          )
      : [];
    return { bindings: bindingRows, sources: sourceRows };
  });
  if (
    !bindings.length ||
    sources.length !== new Set(bindings.map((binding) => binding.connectorId)).size
  )
    return null;
  const collections = await Promise.all(
    sources.map(async (source) => ({ source, snapshots: await read(source) })),
  );
  if (
    collections.some(({ source, snapshots }) => {
      const marker = snapshots.find(
        (snapshot) =>
          snapshot.metadata.kind === 'collection' && snapshot.metadata.resource === 'pods',
      );
      const observed = marker ? new Date(marker.observedAt).getTime() : NaN;
      return (
        source.pollFailureCategory ||
        marker?.metadata.completeness !== 'complete' ||
        !Number.isFinite(observed) ||
        Date.now() - observed > 60_000
      );
    })
  )
    return null;
  return collections.flatMap(({ source, snapshots }) =>
    snapshots.filter((snapshot) => {
      if (snapshot.metadata.kind !== 'pod') return false;
      const labels = snapshot.metadata.labels as Record<string, unknown> | undefined;
      return bindings.some(
        (binding) =>
          binding.connectorId === source.id &&
          binding.namespace === snapshot.metadata.namespace &&
          (!binding.labelKey || labels?.[binding.labelKey] === binding.labelValue),
      );
    }),
  );
}
