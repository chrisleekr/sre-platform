// C6 + C10 — the scheduled evaluator writes burn events, plus the outcome of each attempt onto the
// objective row, and NOTHING else. Pure-unit (no Postgres, no Valkey): every port is injected, so the
// orchestration is provable without infrastructure.
//
// The error budget is a read model, never an ingress: this file is where that stops being a slogan.
// The eval handler is handed a persist port and nothing that could open an incident or enqueue triage
// work, and the source scan below refuses the symbols outright.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import type { IDataSourceConnector } from '@sre/connectors';
import { SliUnsupportedError, type SliReader, type SloForEval } from '@sre/slo';
import { makeFakeSliReader } from '@sre/slo/test-support';
import {
  makeSloEvalHandler,
  makeConnectorSliReader,
  SloScheduler,
  SLO_EVAL_INTERVAL_MS,
  PRUNE_EVERY_N_WINDOWS,
  type BurnEventInput,
  type SloDispatcher,
  type SloEvalHandlerDeps,
} from '../slo-scheduler';
import type { WindowGuard } from '../poller';

const slo: SloForEval = {
  id: 'slo-1',
  tenantId: 'tA',
  name: 'checkout-availability',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
};

const THIRTY_DAYS_SECONDS = 30 * 86_400;

/** 0.0005 over the compliance window, 0.0144 over the short one: budget half spent, burning at 14.4x. */
const twoWindowReader = makeFakeSliReader((q) =>
  q.windowSeconds >= THIRTY_DAYS_SECONDS ? 0.0005 : 0.0144,
);

const job = (over: Record<string, unknown> = {}) => ({
  id: 'j1',
  tenantId: 'tA',
  type: 'slo-eval',
  payload: { sloId: 'slo-1' },
  attempts: 1,
  ...over,
});

function capturingPersist(): {
  persist: SloEvalHandlerDeps['persist'];
  calls: { tenantId: string; event: BurnEventInput }[];
} {
  const calls: { tenantId: string; event: BurnEventInput }[] = [];
  return { persist: async (tenantId, event) => void calls.push({ tenantId, event }), calls };
}

describe('SLO_EVAL_INTERVAL_MS', () => {
  test('is a five-minute cadence, not a per-minute one', () => {
    // The compliance-window read is a range query as wide as the objective's window (up to 30 days)
    // against the tenant's own backend, and it is real network cost. A 30-day budget does not need
    // 60-second freshness.
    expect(SLO_EVAL_INTERVAL_MS).toBe(300_000);
  });
});

describe('makeSloEvalHandler', () => {
  test('C6: resolves the objective, evaluates it, and persists exactly one burn event', async () => {
    const { persist, calls } = capturingPersist();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => slo,
      persist,
      reader: twoWindowReader,
    });

    await handler(job());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.tenantId).toBe('tA');
    // The whole persisted record: no SLI sample, no derived projection, nothing else.
    expect(Object.keys(calls[0]!.event).sort()).toEqual([
      'budgetPct',
      'burnRate',
      'sloId',
      'window',
    ]);
    expect(calls[0]!.event.sloId).toBe('slo-1');
    expect(calls[0]!.event.window).toBe('1h');
    expect(calls[0]!.event.budgetPct).toBeCloseTo(0.5, 6);
    expect(calls[0]!.event.burnRate).toBeCloseTo(14.4, 4);
  });

  test('resolves the objective under the job tenant, never a tenant from the payload', async () => {
    const resolveSlo = vi.fn<SloEvalHandlerDeps['resolveSlo']>(async () => slo);
    const { persist } = capturingPersist();
    const handler = makeSloEvalHandler({ resolveSlo, persist, reader: twoWindowReader });

    await handler(job({ tenantId: 'tA', payload: { sloId: 'slo-1', tenantId: 'tB' } }));

    expect(resolveSlo).toHaveBeenCalledWith('tA', 'slo-1');
  });

  test('ignores jobs of another type and payloads with no objective id', async () => {
    const resolveSlo = vi.fn<SloEvalHandlerDeps['resolveSlo']>(async () => slo);
    const { persist, calls } = capturingPersist();
    const handler = makeSloEvalHandler({ resolveSlo, persist, reader: twoWindowReader });

    await handler(job({ type: 'triage' }));
    await handler(job({ payload: {} }));
    await handler(job({ payload: null }));

    expect(resolveSlo).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  test('an objective deleted or disabled since enqueue is a no-op', async () => {
    const { persist, calls } = capturingPersist();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => null,
      persist,
      reader: twoWindowReader,
    });

    await expect(handler(job({ payload: { sloId: 'gone' } }))).resolves.toBeUndefined();
    expect(calls).toEqual([]);
  });

  test('C10: a connector with no SLI capability skips without persisting and without dead-lettering', async () => {
    const { persist, calls } = capturingPersist();
    const onError = vi.fn();
    const reader: SliReader = {
      querySliRatio: async () => {
        throw new SliUnsupportedError('no prometheus connector exposes an SLI reader');
      },
    };
    const handler = makeSloEvalHandler({ resolveSlo: async () => slo, persist, reader, onError });

    // Resolving (rather than throwing) is what acks the job: the queue never retries it into the
    // dead-letter stream, and the next window re-enumerates the objective from scratch.
    await expect(handler(job())).resolves.toBeUndefined();
    expect(calls).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(SliUnsupportedError);
  });

  test('a backend failure and a resolve failure are both swallowed', async () => {
    const { persist, calls } = capturingPersist();
    const onError = vi.fn();

    const backendDown = makeSloEvalHandler({
      resolveSlo: async () => slo,
      persist,
      reader: { querySliRatio: async () => Promise.reject(new Error('prometheus api 503')) },
      onError,
    });
    await expect(backendDown(job())).resolves.toBeUndefined();

    const resolveDown = makeSloEvalHandler({
      resolveSlo: async () => Promise.reject(new Error('pg down')),
      persist,
      reader: twoWindowReader,
      onError,
    });
    await expect(resolveDown(job())).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(2);
  });
});

// A failed evaluation writes no burn event by design, so before this the objective looked exactly like
// one that had never run. The outcome write is what makes a broken query visible to its owner.
describe('the handler records the outcome of every attempt', () => {
  const outcomeRecorder = () => {
    const calls: { tenantId: string; sloId: string; error: string | null }[] = [];
    return {
      calls,
      recordOutcome: async (tenantId: string, sloId: string, error: string | null) => {
        calls.push({ tenantId, sloId, error });
      },
    };
  };

  test('a successful evaluation records a null outcome, clearing any earlier failure', async () => {
    const { persist, calls } = capturingPersist();
    const { calls: outcomes, recordOutcome } = outcomeRecorder();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => slo,
      persist,
      reader: twoWindowReader,
      recordOutcome,
    });

    await handler(job());
    expect(calls).toHaveLength(1);
    expect(outcomes).toEqual([{ tenantId: 'tA', sloId: 'slo-1', error: null }]);
  });

  test('a rejected query records the reason and still persists nothing', async () => {
    const { persist, calls } = capturingPersist();
    const { calls: outcomes, recordOutcome } = outcomeRecorder();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => slo,
      persist,
      reader: {
        querySliRatio: async () => {
          throw new SliUnsupportedError('no prometheus connector exposes an SLI reader');
        },
      },
      recordOutcome,
    });

    await handler(job());
    expect(calls).toEqual([]);
    expect(outcomes).toEqual([
      { tenantId: 'tA', sloId: 'slo-1', error: 'no prometheus connector exposes an SLI reader' },
    ]);
  });

  test('a failure to record the outcome is swallowed, so it cannot dead-letter the job', async () => {
    const { persist } = capturingPersist();
    const onError = vi.fn();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => slo,
      persist,
      reader: twoWindowReader,
      recordOutcome: async () => {
        throw new Error('outcome write failed');
      },
      onError,
    });

    await expect(handler(job())).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  test('an objective that vanished before evaluation records nothing at all', async () => {
    const { calls: outcomes, recordOutcome } = outcomeRecorder();
    const handler = makeSloEvalHandler({
      resolveSlo: async () => null,
      persist: async () => undefined,
      reader: twoWindowReader,
      recordOutcome,
    });

    await handler(job());
    expect(outcomes).toEqual([]);
  });
});

describe('makeConnectorSliReader', () => {
  const connector = (
    id: string,
    type: string,
    sli?: { sliRatio: (q: { query: string; windowSeconds: number }) => Promise<number> },
  ) => ({ id, name: id, type, sli }) as unknown as IDataSourceConnector;

  test('routes the query to the tenant connector of the objective type that exposes an SLI reader', async () => {
    const seen: { query: string; windowSeconds: number }[] = [];
    const reader = makeConnectorSliReader(async () => [
      connector('c-2', 'datadog', { sliRatio: async () => 0.9 }),
      connector('c-1', 'prometheus', {
        sliRatio: async (q) => {
          seen.push(q);
          return 0.0125;
        },
      }),
    ]);

    const ratio = await reader.querySliRatio({
      tenantId: 'tA',
      connectorType: 'prometheus',
      query: 'bad_ratio',
      windowSeconds: 3600,
    });

    expect(ratio).toBeCloseTo(0.0125, 9);
    expect(seen).toEqual([{ query: 'bad_ratio', windowSeconds: 3600 }]);
  });

  test('resolves ties deterministically by connector id when a tenant runs two of the same backend', async () => {
    // Two Prometheus instances on one tenant cannot be told apart by connector type alone, so the
    // choice is pinned by id: the same objective always reads the same instance.
    const reader = makeConnectorSliReader(async () => [
      connector('c-9', 'prometheus', { sliRatio: async () => 0.9 }),
      connector('c-1', 'prometheus', { sliRatio: async () => 0.1 }),
    ]);

    await expect(
      reader.querySliRatio({
        tenantId: 'tA',
        connectorType: 'prometheus',
        query: 'q',
        windowSeconds: 60,
      }),
    ).resolves.toBeCloseTo(0.1, 9);
  });

  test('skips a connector of the right type that exposes no SLI reader', async () => {
    const reader = makeConnectorSliReader(async () => [
      connector('c-1', 'prometheus'),
      connector('c-2', 'prometheus', { sliRatio: async () => 0.42 }),
    ]);

    await expect(
      reader.querySliRatio({
        tenantId: 'tA',
        connectorType: 'prometheus',
        query: 'q',
        windowSeconds: 60,
      }),
    ).resolves.toBeCloseTo(0.42, 9);
  });

  test('C10: no matching connector raises SliUnsupportedError, distinguishable from an outage', async () => {
    const reader = makeConnectorSliReader(async () => [
      connector('c-1', 'datadog', { sliRatio: async () => 0.5 }),
      connector('c-2', 'prometheus'),
    ]);

    await expect(
      reader.querySliRatio({
        tenantId: 'tA',
        connectorType: 'prometheus',
        query: 'q',
        windowSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(SliUnsupportedError);
  });

  test('resolves the connector list per tenant', async () => {
    const resolve = vi.fn<(tenantId: string) => Promise<IDataSourceConnector[]>>(async () => [
      connector('c-1', 'prometheus', { sliRatio: async () => 0.3 }),
    ]);
    const reader = makeConnectorSliReader(resolve);

    await reader.querySliRatio({
      tenantId: 'tenant-b',
      connectorType: 'prometheus',
      query: 'q',
      windowSeconds: 60,
    });

    expect(resolve).toHaveBeenCalledWith('tenant-b');
  });
});

describe('SloScheduler', () => {
  function dispatcher(): {
    dispatch: SloDispatcher;
    enqueues: { tenantId: string; type: string; payload: unknown }[];
  } {
    const enqueues: { tenantId: string; type: string; payload: unknown }[] = [];
    return {
      dispatch: {
        enqueue: async (input) => {
          enqueues.push(input);
          return `id-${enqueues.length}`;
        },
      },
      enqueues,
    };
  }

  test('C6: enqueues one slo-eval job per tenant and enabled objective, and no other job type', async () => {
    const { dispatch, enqueues } = dispatcher();
    const byTenant: Record<string, { id: string }[]> = {
      tA: [{ id: 'slo-a1' }, { id: 'slo-a2' }],
      tB: [{ id: 'slo-b1' }],
    };
    const scheduler = new SloScheduler({
      guard: async () => true,
      dispatch,
      listTenants: async () => [{ id: 'tA' }, { id: 'tB' }],
      listEnabledSlos: async (tenantId) => byTenant[tenantId] ?? [],
    });

    expect(await scheduler.tick()).toBe(3);
    expect(enqueues).toEqual([
      { tenantId: 'tA', type: 'slo-eval', payload: { sloId: 'slo-a1' } },
      { tenantId: 'tA', type: 'slo-eval', payload: { sloId: 'slo-a2' } },
      { tenantId: 'tB', type: 'slo-eval', payload: { sloId: 'slo-b1' } },
    ]);
    // No triage job, no incident-opening job: measurement does not need an ingress.
    expect(new Set(enqueues.map((e) => e.type))).toEqual(new Set(['slo-eval']));
  });

  test('a contended window enqueues nothing, so replicas do not multiply the backend load', async () => {
    const { dispatch, enqueues } = dispatcher();
    const scheduler = new SloScheduler({
      guard: async () => false,
      dispatch,
      listTenants: async () => [{ id: 'tA' }],
      listEnabledSlos: async () => [{ id: 'slo-a1' }],
    });

    expect(await scheduler.tick()).toBe(0);
    expect(enqueues).toEqual([]);
  });

  test('claims the window with a TTL that self-clears before the next one', async () => {
    const seen: { windowId: number; ttlSec: number }[] = [];
    const guard: WindowGuard = async (windowId, ttlSec) => {
      seen.push({ windowId, ttlSec });
      return true;
    };
    const { dispatch } = dispatcher();
    const scheduler = new SloScheduler({
      guard,
      dispatch,
      listTenants: async () => [],
      listEnabledSlos: async () => [],
      intervalMs: 60_000,
    });

    await scheduler.tick();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.ttlSec).toBe(60);
    expect(seen[0]!.windowId).toBe(Math.floor(Date.now() / 60_000));
  });

  test('start is idempotent and stop clears the timer', () => {
    const { dispatch } = dispatcher();
    const scheduler = new SloScheduler({
      guard: async () => false,
      dispatch,
      listTenants: async () => [],
      listEnabledSlos: async () => [],
    });

    expect(scheduler.running).toBe(false);
    scheduler.start(60_000);
    expect(scheduler.running).toBe(true);
    scheduler.start(60_000);
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
  });
});

// Nothing else removes burn events, so the table grew with a tenant's age forever. The sweep rides the
// fan-out's window guard rather than adding a second lock, and it must never cost an evaluation.
describe('the scheduler sweeps burn-event retention on a slow cadence', () => {
  // The window id is derived from the clock, so the cadence is only testable with the clock pinned.
  const atWindow = (windowId: number, intervalMs: number) =>
    vi.setSystemTime(new Date(windowId * intervalMs));

  function harness(over: Partial<{ prune: (tenantId: string) => Promise<number> }> = {}) {
    const pruned: string[] = [];
    const enqueues: unknown[] = [];
    const scheduler = new SloScheduler({
      guard: async () => true,
      dispatch: {
        enqueue: async (input) => {
          enqueues.push(input);
          return 'id';
        },
      },
      listTenants: async () => [{ id: 'tA' }, { id: 'tB' }],
      listEnabledSlos: async () => [{ id: 'slo-1' }],
      pruneBurnEvents:
        over.prune ??
        (async (tenantId: string) => {
          pruned.push(tenantId);
          return 0;
        }),
      intervalMs: 1000,
    });
    return { scheduler, pruned, enqueues };
  }

  test('sweeps every tenant on a sweep window', async () => {
    vi.useFakeTimers();
    try {
      atWindow(PRUNE_EVERY_N_WINDOWS * 3, 1000);
      const { scheduler, pruned, enqueues } = harness();
      expect(await scheduler.tick()).toBe(2);
      expect(pruned).toEqual(['tA', 'tB']);
      // The sweep is additional to the fan-out, never instead of it.
      expect(enqueues).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not sweep on an ordinary window, so the cadence is not the evaluation cadence', async () => {
    vi.useFakeTimers();
    try {
      atWindow(PRUNE_EVERY_N_WINDOWS * 3 + 1, 1000);
      const { scheduler, pruned, enqueues } = harness();
      expect(await scheduler.tick()).toBe(2);
      expect(pruned).toEqual([]);
      expect(enqueues).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a sweep failure costs no tenant its evaluation', async () => {
    vi.useFakeTimers();
    try {
      atWindow(PRUNE_EVERY_N_WINDOWS * 3, 1000);
      const { scheduler, enqueues } = harness({
        prune: async () => {
          throw new Error('prune failed');
        },
      });
      expect(await scheduler.tick()).toBe(2);
      // Both tenants were still fanned out: the sweep runs after the enqueue and swallows its own failure.
      expect(enqueues).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a scheduler with no prune port simply never sweeps', async () => {
    vi.useFakeTimers();
    try {
      atWindow(PRUNE_EVERY_N_WINDOWS * 3, 1000);
      const scheduler = new SloScheduler({
        guard: async () => true,
        dispatch: { enqueue: async () => 'id' },
        listTenants: async () => [{ id: 'tA' }],
        listEnabledSlos: async () => [{ id: 'slo-1' }],
        intervalMs: 1000,
      });
      expect(await scheduler.tick()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('C7: the evaluator names no incident ingress', () => {
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'slo-scheduler.ts'),
    'utf8',
  );

  for (const symbol of ['createIncident', 'openIncidentWorkspace', 'routeToIncident']) {
    test(`does not name ${symbol}`, () => {
      expect(new RegExp(`\\b${symbol}\\b`).test(source)).toBe(false);
    });
  }

  test('does not import the incident-opening workspace', () => {
    expect(/from\s+['"]@sre\/alerts['"]/.test(source)).toBe(false);
  });

  test('restores nothing from the deleted burn-alert emitter', () => {
    for (const name of [
      'emitBurnAlert',
      'burnSeverity',
      'burnDedupTtlSec',
      'readBurnRatios',
      'evaluateBurnAlert',
      'BurnAlert',
    ]) {
      expect(new RegExp(`\\b${name}\\b`).test(source)).toBe(false);
    }
  });
});
