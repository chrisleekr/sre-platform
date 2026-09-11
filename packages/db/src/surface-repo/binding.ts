import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { lockIncidentWorkTx } from '../incident-relation-repo';
import { withTenant, type Executor } from '../rls';
import { surfaceBindings } from '../schema';
import type { Surface } from './config';

export interface NewBinding {
  incidentId: string;
  surface: Surface;
  /** The channel the incident was born in (a Slack channel id). */
  channel: string;
  /** The root message of the incident's thread (a Slack thread_ts). */
  threadId: string;
  role?: 'primary' | 'source';
}

/**
 * Records surface binding.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param input - Validated input for the operation.
 */
export async function recordSurfaceBinding(exec: Executor, tenantId: string, input: NewBinding) {
  return withTenant(exec, tenantId, async (tx) => {
    const role = input.role ?? 'primary';
    await tx
      .insert(surfaceBindings)
      .values({
        tenantId,
        incidentId: input.incidentId,
        surface: input.surface,
        channel: input.channel,
        threadId: input.threadId,
        role,
        projectionMode: role === 'primary' ? 'full' : 'status',
      })
      .onConflictDoNothing();
    // Re-read rather than trust `.returning()`: on conflict it returns nothing.
    const externalId = threadExternalId(input);
    const rows = await tx
      .select()
      .from(surfaceBindings)
      .where(
        and(
          eq(surfaceBindings.surface, input.surface),
          or(
            eq(surfaceBindings.externalId, externalId),
            role === 'primary'
              ? and(
                  eq(surfaceBindings.incidentId, input.incidentId),
                  eq(surfaceBindings.role, 'primary'),
                )
              : undefined,
          ),
        ),
      )
      .limit(2);
    const forThread = rows.find((r) => r.externalId === externalId);
    if (forThread) return forThread; // whoever owns the thread — the caller's real question
    const forIncident = rows.find((r) => r.incidentId === input.incidentId && r.role === 'primary');
    if (forIncident) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          pkg: '@sre/db',
          msg: 'incident already bound to another thread; binding not moved',
          incidentId: input.incidentId,
          bound: forIncident.externalId,
          requested: externalId,
        }),
      );
      return forIncident;
    }
    // The insert either wrote our row or conflicted with one of the two uniques, both of which the
    // re-read covers. Neither matching is impossible, not a caller-handleable condition.
    throw new Error('surface binding lost');
  });
}

/**
 * Provides activate surface binding.
 *
 * @param exec - Database executor used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function activateSurfaceBinding(
  exec: Executor,
  tenantId: string,
  surface: Surface,
  incidentId: string,
  bindingId: string,
) {
  return withTenant(exec, tenantId, async (tx) => {
    await lockIncidentWorkTx(tx, tenantId, [incidentId]);
    const bindings = await tx
      .select()
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.incidentId, incidentId)))
      .for('update');
    const target = bindings.find((binding) => binding.id === bindingId);
    if (!target) throw new Error('surface binding is not attached to the incident');
    if (target.role === 'primary') return target;

    const primary = bindings.find((binding) => binding.role === 'primary');
    if (primary && primary.channel !== target.channel) return target;
    if (primary)
      await tx
        .update(surfaceBindings)
        .set({ role: 'source', projectionMode: 'status' })
        .where(eq(surfaceBindings.id, primary.id));
    const promoted = await tx
      .update(surfaceBindings)
      .set({ role: 'primary', projectionMode: 'full' })
      .where(eq(surfaceBindings.id, target.id))
      .returning();
    return promoted[0]!;
  });
}

/**
 * Returns binding by incident.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 */
export async function getBindingByIncident(
  db: Executor,
  tenantId: string,
  surface: Surface,
  incidentId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(surfaceBindings)
      .where(
        and(
          eq(surfaceBindings.surface, surface),
          eq(surfaceBindings.incidentId, incidentId),
          eq(surfaceBindings.role, 'primary'),
        ),
      )
      .limit(1);
    return rows[0];
  });
}

/**
 * Resolve one durable projection target. Delivery rows pin this id when the hub message commits.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function getBindingById(
  db: Executor,
  tenantId: string,
  surface: Surface,
  bindingId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.id, bindingId)))
      .limit(1);
    return rows[0];
  });
}

/**
 * Every interactive thread linked to an incident, primary first.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 */
export async function listBindingsByIncident(
  db: Executor,
  tenantId: string,
  surface: Surface,
  incidentId: string,
) {
  return withTenant(db, tenantId, (tx) =>
    tx
      .select()
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.incidentId, incidentId)))
      .orderBy(
        sql`case when ${surfaceBindings.role} = 'primary' then 0 else 1 end`,
        surfaceBindings.createdAt,
      ),
  );
}

/**
 * Returns surface status post.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 */
export async function getSurfaceStatusPost(
  db: Executor,
  tenantId: string,
  surface: Surface,
  incidentId: string,
): Promise<{ messageId: string | null; version: number } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        messageId: surfaceBindings.statusMessageId,
        version: surfaceBindings.statusMessageVersion,
      })
      .from(surfaceBindings)
      .where(
        and(
          eq(surfaceBindings.surface, surface),
          eq(surfaceBindings.incidentId, incidentId),
          eq(surfaceBindings.role, 'primary'),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Read the mutable lifecycle projection for one primary or source thread.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 */
export async function getSurfaceStatusPostByBinding(
  db: Executor,
  tenantId: string,
  surface: Surface,
  bindingId: string,
): Promise<{ messageId: string | null; version: number } | null> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        messageId: surfaceBindings.statusMessageId,
        version: surfaceBindings.statusMessageVersion,
      })
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.id, bindingId)))
      .limit(1);
    return rows[0] ?? null;
  });
}

/**
 * Advance the platform-owned status projection only to a newer lifecycle version.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 * @param messageId - Durable message targeted by the operation.
 * @param version - Value supplied for version.
 */
export async function advanceSurfaceStatusPost(
  db: Executor,
  tenantId: string,
  surface: Surface,
  incidentId: string,
  messageId: string,
  version: number,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(surfaceBindings)
      .set({ statusMessageId: messageId, statusMessageVersion: version })
      .where(
        and(
          eq(surfaceBindings.surface, surface),
          eq(surfaceBindings.incidentId, incidentId),
          eq(surfaceBindings.role, 'primary'),
          or(
            isNull(surfaceBindings.statusMessageId),
            sql`${surfaceBindings.statusMessageVersion} < ${version}`,
          ),
        ),
      )
      .returning({ id: surfaceBindings.id });
    return rows.length === 1;
  });
}

/**
 * Advance one thread's lifecycle projection only to a newer version.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param bindingId - Surface binding targeted by the operation.
 * @param incidentId - Incident targeted by the operation.
 * @param assignmentVersion - Value supplied for assignment version.
 * @param messageId - Durable message targeted by the operation.
 * @param version - Value supplied for version.
 */
export async function advanceSurfaceStatusPostByBinding(
  db: Executor,
  tenantId: string,
  surface: Surface,
  bindingId: string,
  incidentId: string,
  assignmentVersion: number,
  messageId: string,
  version: number,
): Promise<boolean> {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .update(surfaceBindings)
      .set({ statusMessageId: messageId, statusMessageVersion: version })
      .where(
        and(
          eq(surfaceBindings.surface, surface),
          eq(surfaceBindings.id, bindingId),
          eq(surfaceBindings.incidentId, incidentId),
          eq(surfaceBindings.assignmentVersion, assignmentVersion),
          or(
            isNull(surfaceBindings.statusMessageId),
            sql`${surfaceBindings.statusMessageVersion} < ${version}`,
          ),
        ),
      )
      .returning({ id: surfaceBindings.id });
    return rows.length === 1;
  });
}

/**
 * Builds the canonical external identity for a surface thread.
 *
 * @param t - Value supplied for t.
 */
export const threadExternalId = (t: { channel: string; threadId: string }): string =>
  `${t.channel}:${t.threadId}`;

/**
 * Resolve the incident a thread belongs to. `externalId` is `threadExternalId(...)`.
 *
 * @param db - Database connection used for the operation.
 * @param tenantId - Tenant whose records are read or changed.
 * @param surface - Surface adapter targeted by the operation.
 * @param externalId - external id targeted by the operation.
 */
export async function getBindingByExternal(
  db: Executor,
  tenantId: string,
  surface: Surface,
  externalId: string,
) {
  return withTenant(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(surfaceBindings)
      .where(and(eq(surfaceBindings.surface, surface), eq(surfaceBindings.externalId, externalId)))
      .limit(1);
    return rows[0];
  });
}
