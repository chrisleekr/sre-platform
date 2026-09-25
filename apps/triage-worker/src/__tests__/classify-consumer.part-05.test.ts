import { describe, expect, test, vi } from 'vitest';

import type { LlmRuntimeManager } from '../llm-runtime';

// A cancelled classify attempt rethrows its abort instead of failing open to a degraded incident.
vi.mock('@sre/db', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listActiveIncidents: vi.fn(async () => []),
    retrieveNearestActive: vi.fn(async () => []),
    setIncidentEmbedding: vi.fn(async () => undefined),
    bumpIncidentOccurrenceOnce: vi.fn(async () => true),
    getBindingByIncident: vi.fn(async () => undefined),
    activateSurfaceBinding: vi.fn(async () => undefined),
    getSignalByExternal: vi.fn(async () => undefined),
    listUnresolvedSignals: vi.fn(async () => []),
    listSignalsByExternalRoot: vi.fn(async () => []),
    getIncidentLifecycleTx: vi.fn(async () => ({ status: 'open', version: 0 })),
    prepareResponseGroupRecoveryTx: vi.fn(async (_tx, _tenantId: string, incidentId: string) => ({
      rootIncidentId: incidentId,
      lifecycleVersion: 0,
      signalFence: 'signal-0:2:resolved',
    })),
    withTenant: vi.fn(async (_db, _tenantId, fn: (tx: unknown) => unknown) => fn({})),
  };
});

import { createFixture } from './classify-consumer.fixture';

const __fixture = createFixture();

describe('classify cancellation', () => {
  test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const execute = vi.fn(async (meta, run) => {
      expect(meta.signal).toBe(controller.signal);
      controller.abort(reason);
      return run({
        classifier: {
          classify: vi.fn(async () => {
            throw reason;
          }),
        },
      } as never);
    });
    const { handler, route, onOutcome } = __fixture.setup({
      classifyImpl: () => ({ decision: 'not_worthy' }),
      llm: { execute } as unknown as LlmRuntimeManager,
    });

    await expect(handler(__fixture.makeJob(), { signal: controller.signal })).rejects.toBe(reason);
    expect(route).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'fail_open' }));
  });
});
