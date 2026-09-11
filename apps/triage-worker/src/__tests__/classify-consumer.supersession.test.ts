import { describe, expect, test, vi } from 'vitest';

vi.mock('@sre/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listActiveIncidents: vi.fn(async () => []),
    retrieveNearestActive: vi.fn(async () => []),
    listUnresolvedSignals: vi.fn(async () => []),
    listSignalsByExternalRoot: vi.fn(async () => []),
  };
});

import { createFixture } from './classify-consumer.fixture';

const __fixture = createFixture();

describe('classify consumer supersession', () => {
  test('stops before model work when the intake already has a terminal disposition', async () => {
    const candidate = __fixture.makeCandidate({ intakeId: 'intake-suppressed' });
    const { handler, route, classifyFn, onOutcome } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'checkout unavailable',
      }),
      supersededImpl: async () => true,
    });

    await expect(handler(__fixture.makeJob({ payload: candidate }))).resolves.toBeUndefined();

    expect(classifyFn).not.toHaveBeenCalled();
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ intakeId: 'intake-suppressed', outcome: 'superseded' }),
    );
  });

  test('the routing fence wins when suppression commits after both advisory reads', async () => {
    let supersessionReads = 0;
    const candidate = __fixture.makeCandidate({ intakeId: 'intake-suppressed-during-model' });
    const { handler, route, classifyFn, isIntakeSuperseded, withIntakeRoutingFence, onOutcome } =
      __fixture.setup({
        classifyImpl: async () => {
          return {
            decision: 'new_incident',
            service: 'checkout',
            severity: 'sev2',
            title: 'checkout unavailable',
          };
        },
        supersededImpl: async () => {
          supersessionReads += 1;
          if (supersessionReads > 2) throw new Error('post-route supersession read');
          return false;
        },
        routingFenceImpl: async () => ({ status: 'superseded' }),
      });

    await expect(handler(__fixture.makeJob({ payload: candidate }))).resolves.toBeUndefined();

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(isIntakeSuperseded).toHaveBeenCalledTimes(2);
    expect(supersessionReads).toBe(2);
    expect(withIntakeRoutingFence).toHaveBeenCalledTimes(1);
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intakeId: 'intake-suppressed-during-model',
        outcome: 'superseded',
      }),
    );
  });

  test('advances a successfully handled edit reservation to terminal', async () => {
    __fixture.redisEval.mockClear();
    const candidate = __fixture.makeCandidate({
      author: 'bot',
      isEdit: true,
      observations: [
        {
          externalMessageId: 'alert-a',
          state: 'firing',
          summary: 'checkout latency is high',
          contentHash: 'hash-a',
          eventKey: 'event-a',
          eventAt: '2026-08-21T00:00:00.000Z',
        },
        {
          externalMessageId: 'alert-b',
          state: 'firing',
          summary: 'checkout errors are high',
          contentHash: 'hash-b',
          eventKey: 'event-b',
          eventAt: '2026-08-21T00:00:00.000Z',
        },
      ],
    });
    const { handler } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
    });

    await expect(handler(__fixture.makeJob({ payload: candidate }))).resolves.toBeUndefined();

    expect(__fixture.redisEval).toHaveBeenCalledWith(
      expect.stringContaining('currentVersion'),
      2,
      'classify:msg:tenant-1:C123:1699999999.0001',
      'classify:msg:tenant-1:C123:1699999999.0001:event-version',
      'terminal',
      String(BigInt(Date.parse('2026-08-21T00:00:00.000Z')) * 1000n + 999n),
      '2',
      '86400',
    );
  });

  test('does not repeat durable classification when the terminal cache write fails', async () => {
    __fixture.redisEval.mockRejectedValueOnce(new Error('redis unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, route, classifyFn } = __fixture.setup({
      classifyImpl: () => ({
        decision: 'new_incident',
        service: 'checkout',
        severity: 'sev2',
        title: 'checkout unavailable',
      }),
    });

    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();

    expect(classifyFn).toHaveBeenCalledTimes(1);
    expect(route).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('classify.reservation_update_failed'),
    );
    warn.mockRestore();
  });
});
