import { describe, expect, test } from 'vitest';
import { SIGNAL_DISPOSITION_SCENARIOS } from '../signal-disposition-corpus';
import { projectDurableSignalContext } from '../signal-context';

describe('durable signal context projection', () => {
  test('uses the exact live source vocabulary and missing-service shape in corpus evaluation', () => {
    const scenario = SIGNAL_DISPOSITION_SCENARIOS.find((item) => item.id === 'payments-declined')!;
    const evaluation = projectDurableSignalContext({
      signalId: scenario.id,
      jobId: 'job-1',
      summary: scenario.message,
      ...scenario.durableContext,
    });
    const live = projectDurableSignalContext({
      signalId: scenario.id,
      jobId: 'job-1',
      summary: scenario.message,
      author: 'human',
      providerGroupKey: null,
      signalState: 'unknown',
    });

    expect(JSON.stringify(evaluation)).toBe(JSON.stringify(live));
    expect(evaluation).toMatchObject({
      source: 'slack-human',
      author: 'human',
      service: null,
    });
  });

  test('projects provider observations into the live provider source and service', () => {
    expect(
      projectDurableSignalContext({
        signalId: 'provider-1',
        jobId: 'job-1',
        summary: 'Checkout is failing.',
        author: 'bot',
        providerGroupKey: 'checkout',
        signalState: 'firing',
      }),
    ).toMatchObject({
      source: 'slack-provider',
      author: 'provider',
      service: 'checkout',
    });
  });
});
