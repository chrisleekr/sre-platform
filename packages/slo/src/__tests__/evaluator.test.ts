// One evaluation pushes the ratio query DOWN to the metrics backend (two windows: the
// compliance window for budget, the short window for burn) and persists exactly ONE burn event and
// nothing else. No SLI sample is ever stored, so the evaluator is given no sink that could store one.
// Every failure is best-effort: a reader that cannot serve the query and a reader that fails both
// return null without persisting and without rethrowing, which is what keeps the scheduled evaluator
// from dead-lettering. RED until `packages/slo` exists.
import { describe, expect, test, vi } from 'vitest';
import { SliUnsupportedError, type SliQuery, type SliReader } from '../sli-reader';
import { makeFakeSliReader } from '../test-support';
import { evaluateSlo, DEFAULT_BURN_WINDOW, type SloForEval } from '../evaluator';

const slo: SloForEval = {
  id: 'slo-1',
  tenantId: 'tenant-a',
  name: 'checkout-availability',
  service: 'checkout',
  sliType: 'availability',
  target: 0.999,
  windowDays: 30,
  metricQuery: 'sum(rate(errors[$window])) / sum(rate(total[$window]))',
  connectorType: 'prometheus',
};

const THIRTY_DAYS_SECONDS = 30 * 86_400;

/** The only sink the evaluator is given: one burn event, and nothing that could store a sample. */
type PersistBurnEvent = (event: {
  sloId: string;
  budgetPct: number;
  burnRate: number;
  window: string;
}) => Promise<unknown>;

/** A reader that answers 0.0005 over the compliance window and 0.0144 over anything shorter. */
function recordingReader(): { reader: SliReader; queries: SliQuery[] } {
  const queries: SliQuery[] = [];
  const reader = makeFakeSliReader((q) => {
    queries.push(q);
    return q.windowSeconds >= THIRTY_DAYS_SECONDS ? 0.0005 : 0.0144;
  });
  return { reader, queries };
}

describe('DEFAULT_BURN_WINDOW', () => {
  test('is the 1h short window, in both label and seconds', () => {
    expect(DEFAULT_BURN_WINDOW).toEqual({ label: '1h', seconds: 3600 });
  });
});

describe('evaluateSlo', () => {
  test('pushes the stored query down over both windows and persists exactly one burn event', async () => {
    const { reader, queries } = recordingReader();
    const persist = vi.fn<PersistBurnEvent>(async () => ({}));

    const sample = await evaluateSlo({ reader, persist }, slo);

    // The ratio query is evaluated by the backend, not reconstructed here: the stored expression and
    // the tenant/connector routing are handed over verbatim, once per window.
    expect(queries).toEqual([
      {
        tenantId: 'tenant-a',
        connectorType: 'prometheus',
        query: slo.metricQuery,
        windowSeconds: THIRTY_DAYS_SECONDS,
      },
      {
        tenantId: 'tenant-a',
        connectorType: 'prometheus',
        query: slo.metricQuery,
        windowSeconds: 3600,
      },
    ]);

    expect(persist).toHaveBeenCalledTimes(1);
    // Exactly these four fields: the burn event IS the whole persisted record. An extra field here
    // would be the first step towards storing the sample the platform refuses to store.
    const event = persist.mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual(['budgetPct', 'burnRate', 'sloId', 'window']);
    expect(event.sloId).toBe('slo-1');
    expect(event.window).toBe('1h');
    expect(event.budgetPct as number).toBeCloseTo(0.5, 9);
    expect(event.burnRate as number).toBeCloseTo(14.4, 6);

    // The projection is computed on read and returned, never persisted.
    expect(sample).not.toBe(null);
    expect(sample!.sloId).toBe('slo-1');
    expect(sample!.window).toBe('1h');
    expect(sample!.budgetPct).toBeCloseTo(0.5, 9);
    expect(sample!.burnRate).toBeCloseTo(14.4, 6);
    expect(sample!.exhaustionDays).toBeCloseTo(1.0416666, 5);
    expect('exhaustionDays' in event).toBe(false);
  });

  test('honours a custom burn window in both the query and the stored label', async () => {
    const { reader, queries } = recordingReader();
    const persist = vi.fn<PersistBurnEvent>(async () => ({}));

    await evaluateSlo({ reader, persist, burnWindow: { label: '6h', seconds: 21_600 } }, slo);

    expect(queries.map((q) => q.windowSeconds)).toEqual([THIRTY_DAYS_SECONDS, 21_600]);
    expect(persist.mock.calls[0]![0].window).toBe('6h');
  });

  test('a connector that cannot serve the query skips the SLO: no persist, no throw, typed onError', async () => {
    const persist = vi.fn<PersistBurnEvent>(async () => ({}));
    const onError = vi.fn();
    const reader: SliReader = {
      querySliRatio: async () => {
        throw new SliUnsupportedError('no prometheus connector exposes an SLI reader');
      },
    };

    const sample = await evaluateSlo({ reader, persist, onError }, slo);

    expect(sample).toBe(null);
    expect(persist).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    // Distinguishable at the log site from a backend failure: a missing capability is not an outage.
    expect(onError.mock.calls[0]![0]).toBeInstanceOf(SliUnsupportedError);
    expect(onError.mock.calls[0]![1]).toBe(slo);
  });

  test('a metrics-backend failure skips the SLO the same way, without rethrowing', async () => {
    const persist = vi.fn<PersistBurnEvent>(async () => ({}));
    const onError = vi.fn();
    const reader: SliReader = {
      querySliRatio: async () => {
        throw new Error('prometheus api 503');
      },
    };

    await expect(evaluateSlo({ reader, persist, onError }, slo)).resolves.toBe(null);
    expect(persist).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).not.toBeInstanceOf(SliUnsupportedError);
  });

  test('a persist failure is swallowed too, so a write outage never dead-letters the evaluation', async () => {
    const { reader } = recordingReader();
    const onError = vi.fn();
    const persist = vi.fn<PersistBurnEvent>(async () => {
      throw new Error('write failed');
    });

    await expect(evaluateSlo({ reader, persist, onError }, slo)).resolves.toBe(null);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('omitting onError still swallows the failure rather than rejecting', async () => {
    const reader: SliReader = {
      querySliRatio: async () => {
        throw new Error('prometheus api 503');
      },
    };
    await expect(evaluateSlo({ reader, persist: async () => ({}) }, slo)).resolves.toBe(null);
  });
});

describe('makeFakeSliReader', () => {
  test('maps each query to the ratio the caller supplies', async () => {
    const reader = makeFakeSliReader((q) => q.windowSeconds / 10_000);
    await expect(
      reader.querySliRatio({
        tenantId: 't',
        connectorType: 'prometheus',
        query: 'x',
        windowSeconds: 3600,
      }),
    ).resolves.toBeCloseTo(0.36, 9);
  });
});

describe('SliUnsupportedError', () => {
  test('is an Error subclass carrying its own name, so a log site can branch on it', () => {
    const err = new SliUnsupportedError('nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SliUnsupportedError');
    expect(err.message).toBe('nope');
  });
});
