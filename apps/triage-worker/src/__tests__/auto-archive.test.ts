import { describe, expect, test, vi } from 'vitest';
import {
  archiveIdleTerminalIncidents,
  runAutoArchiveSweep,
  runConfiguredAutoArchiveSweep,
  type AutoArchiveSweepDeps,
} from '../auto-archive';

describe('runAutoArchiveSweep', () => {
  test('rereads the policy on every run, skips work at zero, and computes the configured cutoff', async () => {
    const values = [0, 7, 3];
    const getArchiveDays = vi.fn(async () => values.shift()!);
    const sweep = vi.fn(async () => 2);
    const now = () => new Date('2026-08-27T00:00:00.000Z').getTime();

    expect(await runConfiguredAutoArchiveSweep({ getArchiveDays, sweep, now })).toEqual({
      archiveDays: 0,
      archived: 0,
      idleBefore: null,
    });
    expect(sweep).not.toHaveBeenCalled();

    expect(await runConfiguredAutoArchiveSweep({ getArchiveDays, sweep, now })).toEqual({
      archiveDays: 7,
      archived: 2,
      idleBefore: new Date('2026-08-20T00:00:00.000Z'),
    });
    expect(await runConfiguredAutoArchiveSweep({ getArchiveDays, sweep, now })).toEqual({
      archiveDays: 3,
      archived: 2,
      idleBefore: new Date('2026-08-24T00:00:00.000Z'),
    });
    expect(getArchiveDays).toHaveBeenCalledTimes(3);
    expect(sweep.mock.calls).toEqual([
      [new Date('2026-08-20T00:00:00.000Z')],
      [new Date('2026-08-24T00:00:00.000Z')],
    ]);
  });

  test('deletes each terminal candidate through the audited, version-fenced tombstone path', async () => {
    const idleBefore = new Date('2026-08-20T00:00:00.000Z');
    const archive = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'applied' })
      .mockResolvedValueOnce({ outcome: 'precondition_failed' });

    const archived = await archiveIdleTerminalIncidents(
      {
        listIdle: async () => [
          { id: 'incident-a', lifecycleVersion: 2 },
          { id: 'incident-b', lifecycleVersion: 4 },
        ],
        archive,
      },
      'tenant-a',
      idleBefore,
    );

    expect(archived).toBe(1);
    expect(archive).toHaveBeenNthCalledWith(1, 'tenant-a', 'incident-a', {
      archived: true,
      reason: 'Automatically deleted after the terminal incident remained inactive.',
      archiveKey: 'idle-archive:incident-a:2:2026-08-20T00:00:00.000Z',
      author: 'system',
      expectedVersion: 2,
      idleBefore,
    });
  });

  test('does not retry a deleted record once it leaves the eligible candidate list', async () => {
    const archive = vi.fn(
      async (_tenantId: string, _incidentId: string, _input: { archiveKey: string }) => ({
        outcome: 'applied',
      }),
    );
    const candidates = [[{ id: 'incident-a', lifecycleVersion: 2 }], []];
    const deps = {
      listIdle: async () => candidates.shift()!,
      archive,
    };

    await archiveIdleTerminalIncidents(deps, 'tenant-a', new Date('2026-08-20T00:00:00.000Z'));
    await archiveIdleTerminalIncidents(deps, 'tenant-a', new Date('2026-08-27T00:00:00.000Z'));

    expect(archive).toHaveBeenCalledTimes(1);
  });

  test('invokes the tenant-scoped archive path', async () => {
    const listTenants = vi.fn(async () => [{ id: 'tA' }]);
    const archiveIdle = vi.fn(async (_tenantId: string) => 2);
    const deps: AutoArchiveSweepDeps = { listTenants, archiveIdle };

    const archived = await runAutoArchiveSweep(deps);

    expect(listTenants).toHaveBeenCalledTimes(1);
    expect(archiveIdle).toHaveBeenCalledWith('tA');
    expect(archived).toBe(2);
  });

  test('continues with other tenants when one archive path fails', async () => {
    const listTenants = vi.fn(async () => [{ id: 'tA' }, { id: 'tB' }, { id: 'tC' }]);
    const archiveIdle = vi.fn(async (tenantId: string) => {
      if (tenantId === 'tB') throw new Error('tB archive failed');
      return 1;
    });
    const onError = vi.fn();

    const archived = await runAutoArchiveSweep({ listTenants, archiveIdle, onError });

    expect(archiveIdle.mock.calls.map((call) => call[0])).toEqual(['tA', 'tB', 'tC']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(archived).toBe(2);
  });
});
