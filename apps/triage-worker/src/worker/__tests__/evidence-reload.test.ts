// The shared evidence-reload seam. Every reload path goes through it, so what it does when the
// operator-set row ceiling cannot be read decides whether a transient settings failure costs an
// investigation its whole working memory.
import { describe, expect, test, vi, afterEach } from 'vitest';
import { reloadIncidentEvidence } from '../evidence';
import type { TriageWorkerDeps } from '../contracts';

// Typed by its arguments, not inferred: an inferred `[]` tuple makes the option-object assertions
// below a compile error rather than a check.
const loadIncidentEvidence = vi.hoisted(() =>
  vi.fn((..._args: unknown[]): Promise<unknown[]> => Promise.resolve([])),
);
vi.mock('@sre/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sre/db')>()),
  loadIncidentEvidence,
}));

/** Minimal deps: the seam touches only the database handle and the two bound accessors. */
function makeDeps(
  getEvidenceRowLimit?: TriageWorkerDeps['getEvidenceRowLimit'],
  getEvidenceBudgetChars?: TriageWorkerDeps['getEvidenceBudgetChars'],
): Pick<TriageWorkerDeps, 'appDb' | 'getEvidenceRowLimit' | 'getEvidenceBudgetChars'> {
  return {
    appDb: {} as TriageWorkerDeps['appDb'],
    getEvidenceRowLimit,
    getEvidenceBudgetChars,
  };
}

afterEach(() => {
  loadIncidentEvidence.mockClear();
});

describe('reloadIncidentEvidence operator bounds', () => {
  test('passes both operator-set bounds through', async () => {
    await reloadIncidentEvidence(
      makeDeps(
        async () => 250,
        async () => 5000,
      ),
      'tenant-1',
      'incident-1',
    );
    expect(loadIncidentEvidence.mock.calls[0]![3]).toMatchObject({ limit: 250, budget: 5000 });
  });

  test('deps without the accessors reload at the repository defaults', async () => {
    // Both accessors are optional on TriageWorkerDeps, so this is the shape of every worker built
    // outside the app entrypoint; the optional-call branches are otherwise never exercised.
    await reloadIncidentEvidence(makeDeps(), 'tenant-1', 'incident-1');
    expect(loadIncidentEvidence).toHaveBeenCalledTimes(1);
    // Both undefined: the repository owns each default, and pinning a value here would let the two
    // copies drift apart while this test stayed green.
    expect(loadIncidentEvidence.mock.calls[0]![3]).toMatchObject({
      limit: undefined,
      budget: undefined,
    });
  });

  test('unreadable bounds still reload, at the module defaults', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnings: string[] = [];
    try {
      await reloadIncidentEvidence(
        // Only the ceiling throws. Both are abandoned anyway, which is the documented behaviour:
        // they share one settings store, so a partial failure is not a case worth preserving a
        // half-configured read for.
        makeDeps(
          async () => {
            throw new Error('settings unavailable');
          },
          async () => 5000,
        ),
        'tenant-1',
        'incident-1',
      );
      // Read before restoring: mockRestore clears the recorded calls, so asserting after it would
      // read an empty list and pass for a seam that logged nothing.
      warnings = warn.mock.calls.map((call) => String(call[0]));
    } finally {
      warn.mockRestore();
    }

    // The reload must still happen. Every caller wraps this in a catch that drops ALL evidence, so
    // a propagated settings failure would blank the investigation rather than bound its read.
    expect(loadIncidentEvidence).toHaveBeenCalledTimes(1);
    // Both abandoned, not just the one that threw. Asserting the reachable 5000 is ABSENT is the
    // point: a change that kept the readable bound while dropping the failed one would still
    // satisfy a looser assertion, and would resume an investigation on half-configured limits.
    expect(loadIncidentEvidence.mock.calls[0]![3]).toMatchObject({
      limit: undefined,
      budget: undefined,
    });
    expect(warnings.some((line) => line.includes('evidence_bounds_unavailable'))).toBe(true);
  });
});
