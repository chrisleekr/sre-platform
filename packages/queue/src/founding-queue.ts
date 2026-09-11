import { jobs, type Db, type FoundingJobInsert, type Tx } from '@sre/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Queue } from './queue';
import type { QueueOptions } from './queue/contracts';

export const FOUNDING_JOB_TYPE = 'founding.provision';
export const TENANT_PURGE_JOB_TYPE = 'tenant.purge';
export const FOUNDING_JOB_STREAM = 'sre:founding';
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Dedicated durable queue for workspace provisioning before a tenant id exists. */
export class FoundingQueue extends Queue {
  constructor(db: Db, redis: Redis, options: QueueOptions = {}) {
    super(db, redis, {
      ...options,
      stream: FOUNDING_JOB_STREAM,
      group: options.group ?? 'founding-workers',
      deadStream: options.deadStream ?? 'sre:founding:dead',
    });
  }

  /** Inserts or reuses the one live provisioning command for a founding. */
  async insertProvisionTx(tx: Tx, foundingId: string): Promise<FoundingJobInsert> {
    const rows = await tx
      .insert(jobs)
      .values({
        tenantId: SYSTEM_TENANT_ID,
        type: FOUNDING_JOB_TYPE,
        payload: { foundingId },
        idempotencyKey: foundingId,
        status: 'queued',
        stream: FOUNDING_JOB_STREAM,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (rows[0]) return { jobId: rows[0].id, created: true };
    const existing = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.tenantId, SYSTEM_TENANT_ID),
          eq(jobs.type, FOUNDING_JOB_TYPE),
          eq(jobs.idempotencyKey, foundingId),
          inArray(jobs.status, ['queued', 'processing']),
        ),
      )
      .limit(1);
    if (!existing[0]) throw new Error('founding job conflict disappeared');
    return { jobId: existing[0].id, created: false };
  }

  /** Inserts or reuses the one live delayed purge command for a workspace. */
  async insertTenantPurgeTx(
    tx: Tx,
    tenantId: string,
    availableAt: Date,
  ): Promise<FoundingJobInsert> {
    const rows = await tx
      .insert(jobs)
      .values({
        tenantId: SYSTEM_TENANT_ID,
        type: TENANT_PURGE_JOB_TYPE,
        payload: { tenantId },
        idempotencyKey: `tenant.purge:${tenantId}`,
        status: 'queued',
        stream: FOUNDING_JOB_STREAM,
        availableAt,
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (rows[0]) return { jobId: rows[0].id, created: true };
    const [existing] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, TENANT_PURGE_JOB_TYPE),
          sql`${jobs.payload}->>'tenantId' = ${tenantId}`,
          inArray(jobs.status, ['queued', 'processing']),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('workspace purge job conflict disappeared');
    return { jobId: existing.id, created: false };
  }
}

/**
 * Creates the dedicated founding queue with standard durable delivery semantics.
 *
 * @param db - Database connection used for durable commands.
 * @param redis - Valkey connection used for stream delivery.
 * @param options - Optional queue naming and timing overrides.
 */
export function makeFoundingQueue(db: Db, redis: Redis, options: QueueOptions = {}): FoundingQueue {
  return new FoundingQueue(db, redis, options);
}
