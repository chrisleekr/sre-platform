import type { Job, JobHandler } from '@sre/queue';

export const DOMAIN_VERIFY_JOB_TYPE = 'domain.verify';

/** Creates a strict handler for one durable domain verification command. */
export function makeDomainVerificationJobHandler(dependencies: {
  check(domainId: string, currentJobId: string): Promise<unknown>;
}): JobHandler {
  return async (job: Job) => {
    if (job.type !== DOMAIN_VERIFY_JOB_TYPE) {
      throw new Error(`unexpected domain verification job type: ${job.type}`);
    }
    const domainId = (job.payload as { domainId?: unknown } | null)?.domainId;
    if (typeof domainId !== 'string' || !domainId) {
      throw new Error('domain verification job is missing domainId');
    }
    await dependencies.check(domainId, job.id);
  };
}
