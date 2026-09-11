import { expect, test, vi } from 'vitest';
import { withEvaluationReport } from '../evaluation-report';
import { ProviderRateLimitError } from '../../engine/types';

test('a stopped model evaluation exports partial usage before teardown without retry', async () => {
  const events: unknown[] = [];
  const usage = [{ operation: 'responder-intent', requests: 1 }];
  const state = { passed: 1, failed: 0, currentCase: 'second case' };
  const error = new ProviderRateLimitError();
  const run = vi.fn(async () => {
    throw error;
  });
  try {
    await expect(
      withEvaluationReport(
        state,
        run,
        async () => usage,
        (event) => events.push(event),
      ),
    ).rejects.toBe(error);
  } finally {
    events.push('storage destroyed');
  }
  expect(run).toHaveBeenCalledTimes(1);
  expect(events).toEqual([
    { event: 'partial', ...state, usage, error: 'ProviderRateLimitError' },
    'storage destroyed',
  ]);
});
