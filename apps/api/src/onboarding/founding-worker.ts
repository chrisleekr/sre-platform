import { randomUUID } from 'node:crypto';
import {
  failFounding,
  expireWorkspaceFoundings,
  markFoundingProvisioning,
  provisionFounding,
  purgeWorkspaceIfDue,
  requeueStaleFoundings,
  type Db,
} from '@sre/db';
import {
  FOUNDING_JOB_TYPE,
  TENANT_PURGE_JOB_TYPE,
  type FoundingQueue,
  type Job,
  type JobHandler,
} from '@sre/queue';
import { DOMAIN_VERIFY_JOB_TYPE } from './domain-worker';

function databaseFailure(error: unknown): { code?: string; constraint?: string } {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
    };
    if (value.code) {
      return { code: value.code, constraint: value.constraint ?? value.constraint_name };
    }
    current = value.cause;
  }
  return {};
}

/** Creates the idempotent handler for one durable founding command. */
export function makeFoundingJobHandler(db: Db): JobHandler {
  return async (job: Job) => {
    if (job.type !== FOUNDING_JOB_TYPE)
      throw new Error(`unexpected founding job type: ${job.type}`);
    const foundingId = (job.payload as { foundingId?: unknown } | null)?.foundingId;
    if (typeof foundingId !== 'string') throw new Error('founding job is missing foundingId');
    if ((await markFoundingProvisioning(db, foundingId)) === 'already_active') return;
    try {
      await provisionFounding(db, foundingId);
    } catch (error) {
      const failure = databaseFailure(error);
      if (failure.code === '23505' && failure.constraint?.includes('tenants_slug')) {
        await failFounding(db, foundingId, 'address taken');
        return;
      }
      throw error;
    }
  };
}

/** Routes the shared founding stream to its strict command handlers. */
export function makeFoundingDispatchHandler(
  provision: JobHandler,
  verifyDomain: JobHandler,
  purgeTenant: JobHandler,
): JobHandler {
  return (job, ctx) => {
    if (job.type === DOMAIN_VERIFY_JOB_TYPE) return verifyDomain(job, ctx);
    if (job.type === TENANT_PURGE_JOB_TYPE) return purgeTenant(job, ctx);
    return provision(job, ctx);
  };
}

/** Creates the handler for one due workspace purge command. */
export function makeTenantPurgeJobHandler(db: Db): JobHandler {
  return async (job: Job) => {
    if (job.type !== TENANT_PURGE_JOB_TYPE) {
      throw new Error(`unexpected workspace purge job type: ${job.type}`);
    }
    const tenantId = (job.payload as { tenantId?: unknown } | null)?.tenantId;
    if (typeof tenantId !== 'string' || !tenantId) {
      throw new Error('workspace purge job is missing tenantId');
    }
    await purgeWorkspaceIfDue(db, tenantId);
  };
}

/** Starts polling and recovery for the API-owned founding stream. */
export async function startFoundingWorker(
  queue: FoundingQueue,
  handler: JobHandler,
  options: {
    db: Db;
    pollMs?: number;
    reconcileMs?: number;
    consumer?: string;
    onError?: (error: unknown) => void;
  },
): Promise<{ stop(): Promise<void> }> {
  const pollMs = options.pollMs ?? 250;
  const reconcileMs = options.reconcileMs ?? 60_000;
  const consumer = options.consumer ?? `founding-${randomUUID().slice(0, 8)}`;
  await queue.ensureGroup();
  await queue.dispatchDue();
  let stopped = false;
  let running: Promise<void> | null = null;
  let lastReconcile = Date.now();
  const tick = (): void => {
    if (stopped || running) return;
    running = (async () => {
      const now = Date.now();
      if (now - lastReconcile >= reconcileMs) {
        await queue.dispatchDue();
        await queue.reconcile();
        await expireWorkspaceFoundings(options.db);
        const stale = await requeueStaleFoundings(options.db, queue.insertProvisionTx.bind(queue));
        for (const jobId of stale) await queue.publishJob(jobId);
        lastReconcile = now;
      }
      await queue.process(consumer, handler);
    })()
      .catch((error) => options.onError?.(error))
      .finally(() => {
        running = null;
      });
  };
  tick();
  const timer = setInterval(tick, pollMs);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
