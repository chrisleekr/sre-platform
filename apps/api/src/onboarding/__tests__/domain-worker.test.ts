import { describe, expect, test, vi } from 'vitest';
import type { FoundingQueue, Job } from '@sre/queue';
import type { Db } from '@sre/db';
import { DOMAIN_VERIFY_JOB_TYPE, makeDomainVerificationJobHandler } from '../domain-worker';
import { makeFoundingDispatchHandler, startFoundingWorker } from '../founding-worker';

describe('domain verification worker', () => {
  test('handles only a well-formed domain verification command', async () => {
    const check = vi.fn(async () => undefined);
    const handler = makeDomainVerificationJobHandler({ check });

    await handler(
      {
        id: 'job-1',
        tenantId: 'tenant-1',
        type: DOMAIN_VERIFY_JOB_TYPE,
        payload: { domainId: 'domain-1' },
        attempts: 1,
      },
      { signal: new AbortController().signal },
    );
    expect(check).toHaveBeenCalledWith('domain-1', 'job-1');

    await expect(
      handler(
        {
          id: 'job-2',
          tenantId: 'tenant-1',
          type: DOMAIN_VERIFY_JOB_TYPE,
          payload: {},
          attempts: 1,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/domainId/i);
  });

  test('dispatches due work before consumption and routes domain verification on the shared worker', async () => {
    const calls: string[] = [];
    const dispatchDue = vi.fn(async () => {
      calls.push('dispatch');
      return 1;
    });
    const domainCheck = vi.fn(async () => undefined);
    const provision = vi.fn(async () => undefined);
    const handler = makeFoundingDispatchHandler(
      provision,
      makeDomainVerificationJobHandler({ check: domainCheck }),
      vi.fn(async () => undefined),
    );
    let consumed = false;
    const job: Job = {
      id: 'job-due',
      tenantId: 'tenant-1',
      type: DOMAIN_VERIFY_JOB_TYPE,
      payload: { domainId: 'domain-due' },
      attempts: 1,
    };
    const process = vi.fn(async (_consumer: string, consume: (job: Job) => Promise<void>) => {
      if (consumed) return 0;
      consumed = true;
      calls.push('process');
      await consume(job);
      return 1;
    });
    const queue = {
      ensureGroup: vi.fn(async () => undefined),
      dispatchDue,
      process,
      reconcile: vi.fn(async () => 0),
      insertProvisionTx: vi.fn(),
      publishJob: vi.fn(async () => undefined),
    } as unknown as FoundingQueue;

    const worker = await startFoundingWorker(queue, handler, {
      db: {} as Db,
      pollMs: 5,
      reconcileMs: Number.MAX_SAFE_INTEGER,
      consumer: 'founding-test',
    });
    try {
      await vi.waitFor(() => expect(domainCheck).toHaveBeenCalledWith('domain-due', 'job-due'), {
        timeout: 250,
      });
      expect(queue.ensureGroup).toHaveBeenCalledOnce();
      expect(calls.slice(0, 2)).toEqual(['dispatch', 'process']);
      expect(provision).not.toHaveBeenCalled();
    } finally {
      await worker.stop();
    }
  });
});
