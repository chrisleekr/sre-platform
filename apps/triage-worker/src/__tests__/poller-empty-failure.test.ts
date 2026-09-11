import { expect, test, vi } from 'vitest';
import { makePollHandler } from '../poller';
import { createFixture } from './poller.fixture';

test.each(['provider_unavailable', 'group_scope_changed', 'rate_limited'])(
  'retains cached evidence and reports an empty failed poll: %s',
  async (failureCategory) => {
    const fixture = createFixture();
    const previous = [fixture.gitlabDeploySnap('t1', 'service', 'last-good')];
    const evidence = {
      cursor: { revision: 2, retryAt: '2026-09-09T00:01:00Z' },
      errorCount: 1,
      failureCategory,
    };
    const connector = {
      ...fixture.fakeConnector('gitlab', async () => []),
      pollEvidence: () => evidence,
    };
    const { cache, sets } = fixture.fakeCache();
    cache.get = async () => previous;
    const persistDeploys = vi.fn(async () => true);
    const onOutcome = vi.fn();
    const handler = makePollHandler({
      connectorProvider: () => async () => [connector],
      cache,
      ttlSec: 90,
      persistDeploys,
      onOutcome,
    });
    await handler({
      id: 'poll-job',
      tenantId: 't1',
      type: 'poll',
      payload: { connectorType: 'gitlab' },
      attempts: 1,
    });
    expect(persistDeploys).toHaveBeenCalledWith('t1', [], 'gitlab', evidence, undefined);
    expect(sets).toHaveLength(1);
    expect(sets[0]!.snapshots).toEqual(previous);
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failure', errorCount: 1, keptLastGood: true }),
    );
  },
);
