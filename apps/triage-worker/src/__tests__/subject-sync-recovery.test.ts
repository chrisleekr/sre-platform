import { describe, expect, test, vi } from 'vitest';
import { recoverMissingSubjectSyncJobs } from '../subject-sync-recovery';

describe('subject synchronization recovery', () => {
  test('continues across tenant and incident failures while counting scheduled work', async () => {
    const enqueue = vi.fn(async (tenantId: string, incidentId: string) => {
      if (incidentId === 'incident-broken') throw new Error('queue unavailable');
      expect(tenantId).toMatch(/^tenant-/);
    });
    const onError = vi.fn();

    await expect(
      recoverMissingSubjectSyncJobs({
        listTenants: async () => [{ id: 'tenant-a' }, { id: 'tenant-b' }, { id: 'tenant-broken' }],
        listCandidates: async (tenantId) => {
          if (tenantId === 'tenant-broken') throw new Error('database unavailable');
          return tenantId === 'tenant-a' ? ['incident-a', 'incident-broken'] : ['incident-b'];
        },
        enqueue,
        onError,
      }),
    ).resolves.toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      tenantId: 'tenant-a',
      incidentId: 'incident-broken',
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), { tenantId: 'tenant-broken' });
  });
});
