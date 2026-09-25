import { readFileSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import { runConsumerLoop, superviseConsumer } from '../consumer-loop';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('pauses only after a turn that handled nothing', async () => {
  vi.useFakeTimers();
  const stop = new Error('stop');
  const turn = vi
    .fn<() => Promise<number>>()
    .mockResolvedValueOnce(2)
    .mockResolvedValueOnce(0)
    .mockRejectedValue(stop);
  const settled = expect(runConsumerLoop(turn, 1000)).rejects.toBe(stop);
  await vi.advanceTimersByTimeAsync(0);
  // The busy turn went straight to the next one; the empty turn is now waiting out its pause.
  expect(turn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(turn).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  await settled;
  expect(turn).toHaveBeenCalledTimes(3);
});

test('a long turn in one supervised loop does not hold up another', async () => {
  let finish!: () => void;
  const investigation = new Promise<number>((resolve) => (finish = () => resolve(1)));
  const stop = new Error('stop');
  const triage = vi.fn<() => Promise<number>>().mockReturnValueOnce(investigation);
  const polls = vi.fn<() => Promise<number>>();
  const exit = vi.fn();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  superviseConsumer('triage', () => runConsumerLoop(triage), exit);
  for (let i = 0; i < 3; i++) polls.mockResolvedValueOnce(1);
  polls.mockRejectedValueOnce(stop);
  const pollLoop = runConsumerLoop(polls);
  await expect(pollLoop).rejects.toBe(stop);
  expect(polls).toHaveBeenCalledTimes(4);
  expect(triage).toHaveBeenCalledTimes(1);
  triage.mockRejectedValue(stop);
  finish();
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
});

test('exits the process and names the consumer when its loop fails', async () => {
  const exit = vi.fn();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  superviseConsumer('triage', () => Promise.reject(new Error('valkey down')), exit);
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
  const line = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
  expect(line).toMatchObject({
    level: 'error',
    msg: 'consumer loop failed; exiting',
    consumer: 'triage',
    error: 'valkey down',
  });
});

test('production wiring runs triage in its own supervised loop, not the shared one', () => {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  expect(source).toContain(
    "superviseConsumer('triage', () => runConsumerLoop(() => worker.tick()))",
  );
  const shared = source.slice(source.indexOf('for (;;) {'));
  expect(shared).toContain("pollQueue.process('poll-worker'");
  expect(shared).not.toContain('worker.tick');
});
