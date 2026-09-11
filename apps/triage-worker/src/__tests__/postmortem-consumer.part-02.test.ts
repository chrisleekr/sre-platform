import { describe, expect, test, vi } from 'vitest';
import { POSTMORTEM_TIMELINE_AT_MAX_CHARS } from '@sre/contracts';
import { RetryableError } from '@sre/queue';
import { makeFakeGenerator } from '../engine/fake';
import { ProviderUnavailableError } from '../engine/types';
import { createFixture } from './postmortem-consumer.fixture';
import type { LlmRuntimeManager } from '../llm-runtime';

const __fixture = createFixture();

// Redelivery ceiling for a provider outage: below the queue's retryableMaxAttempts so a sustained
// outage posts "generation failed" and ACKS before the queue dead-letters. Production pins the same
// value as the runbook consumer.
const FAIL_MAX = 5;

// failure handling. A provider outage redelivers boundedly, then posts a dashboard-only
// system line and acks. The incident row is never touched from this consumer.
describe('makePostmortemHandler failure handling', () => {
  test('passes the attempt signal to the runtime and rethrows an aborted provider call', async () => {
    const controller = new AbortController();
    const reason = new Error('deadline');
    const execute = vi.fn(async (meta, run) => {
      expect(meta.signal).toBe(controller.signal);
      controller.abort(reason);
      return run({
        generator: {
          generate: vi.fn(async () => {
            throw reason;
          }),
        },
      } as never);
    });
    const { handler, append, saveGeneratedPostmortem } = __fixture.setup({
      llm: { execute } as unknown as LlmRuntimeManager,
    });

    await expect(handler(__fixture.makeJob(), { signal: controller.signal })).rejects.toBe(reason);
    expect(append).not.toHaveBeenCalled();
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
  });

  test('a provider outage below FAIL_MAX throws RetryableError and writes nothing', async () => {
    const { handler, saveGeneratedPostmortem, append } = __fixture.setup({
      generateThrows: new ProviderUnavailableError('rate limited'),
    });
    await expect(handler(__fixture.makeJob({ attempts: FAIL_MAX - 1 }))).rejects.toBeInstanceOf(
      RetryableError,
    );
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
    expect(append).not.toHaveBeenCalled();
  });

  test('a provider outage at FAIL_MAX acks with a dashboard-only failure note', async () => {
    const { handler, saveGeneratedPostmortem, append } = __fixture.setup({
      generateThrows: new ProviderUnavailableError('still down'),
    });
    await expect(handler(__fixture.makeJob({ attempts: FAIL_MAX }))).resolves.toBeUndefined();
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    // kind 'text' from author 'system' is never mirrored to Slack (hub surface policy).
    expect(append.mock.calls[0]![2]).toMatchObject({ author: 'system', kind: 'text' });
    expect(append.mock.calls[0]![2].content).toContain('generation failed');
  });

  test('a non-outage generator failure is terminal on the first attempt', async () => {
    const { handler, append } = __fixture.setup({
      generateThrows: new Error('schema mismatch'),
    });
    await expect(handler(__fixture.makeJob({ attempts: 1 }))).resolves.toBeUndefined();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2].content).toContain('generation failed');
  });

  test('a draft the PATCH validator would reject is terminal: blank prose or an over-long timeline `at`', async () => {
    // makeFakeGenerator applies schema.parse, which the scripted spy never does.
    for (const over of [
      { impact: '' },
      { timeline: [{ at: 'x'.repeat(POSTMORTEM_TIMELINE_AT_MAX_CHARS + 1), event: 'e' }] },
    ]) {
      const { handler, saveGeneratedPostmortem, append } = __fixture.setup({
        generator: makeFakeGenerator(() => __fixture.draft(over)),
      });
      await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
      expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
      expect(append).toHaveBeenCalledTimes(1);
      expect(append.mock.calls[0]![2].content).toContain('generation failed');
    }
  });

  test('whitespace-only prose passes min(1) but is refused before it becomes the public fallback sentence', async () => {
    const { handler, saveGeneratedPostmortem, append } = __fixture.setup({
      generator: makeFakeGenerator(() => __fixture.draft({ impact: '   ' })),
    });
    await expect(handler(__fixture.makeJob())).resolves.toBeUndefined();
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2].content).toContain('generation failed');
  });

  test('a save failure propagates so the queue retries, and no success line is posted', async () => {
    const { handler, saveGeneratedPostmortem, append } = __fixture.setup({});
    saveGeneratedPostmortem.mockRejectedValueOnce(new Error('connection reset'));
    await expect(handler(__fixture.makeJob())).rejects.toThrow('connection reset');
    expect(append).not.toHaveBeenCalled();
  });

  test('a job with no valid declared trigger is refused with a dashboard-only note, never given one', async () => {
    const { handler, generate, saveGeneratedPostmortem, append } = __fixture.setup({});
    await expect(
      handler(__fixture.makeJob({ payload: { incidentId: 'inc-1', trigger: 'bogus' } })),
    ).resolves.toBeUndefined();
    expect(generate).not.toHaveBeenCalled();
    expect(saveGeneratedPostmortem).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![2]).toMatchObject({
      author: 'system',
      kind: 'text',
      content: 'Postmortem generation was refused: no valid trigger was declared.',
    });
  });
});
