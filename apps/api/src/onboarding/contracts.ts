import type { FoundingJobInsert, Tx } from '@sre/db';

export interface PublicRateLimiter {
  allow(scope: string, subject: string, limit: number, windowMs: number): Promise<boolean>;
}

export interface FoundingQueuePort {
  insertProvisionTx(tx: Tx, foundingId: string): Promise<FoundingJobInsert>;
  insertTenantPurgeTx(tx: Tx, tenantId: string, availableAt: Date): Promise<FoundingJobInsert>;
  publishJob(jobId: string): Promise<void>;
}
