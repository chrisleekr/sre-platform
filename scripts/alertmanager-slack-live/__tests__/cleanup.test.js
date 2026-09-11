import { describe, expect, test, vi } from 'vitest';
import { removeContainerChecked, settleOrThrow } from '../cleanup.mjs';

describe('live acceptance cleanup', () => {
  test('fails when removal rejects and the container still exists', async () => {
    const run = vi.fn(async (args) => {
      if (args[1] === 'rm') throw new Error('removal denied');
      return 'container-id';
    });

    await expect(removeContainerChecked(run, 'owned-test-container')).rejects.toThrow(
      /remains after cleanup/,
    );
  });

  test('does not mistake an unavailable Docker inspection for absence', async () => {
    const run = vi.fn(async (args) => {
      if (args[1] === 'inspect') throw new Error('permission denied');
      return '';
    });

    await expect(removeContainerChecked(run, 'owned-test-container')).rejects.toThrow(
      /could not verify cleanup/,
    );
  });

  test('accepts only Docker no-such-object as verified absence', async () => {
    const run = vi.fn(async (args) => {
      if (args[1] === 'inspect') throw new Error('Error: No such object: owned-test-container');
      return '';
    });

    await expect(removeContainerChecked(run, 'owned-test-container')).resolves.toBeUndefined();
  });

  test('waits for every cleanup and reports every failure', async () => {
    const attempted = [];
    const first = Promise.resolve().then(() => {
      attempted.push('process');
      throw new Error('process stop failed');
    });
    const second = Promise.resolve().then(() => {
      attempted.push('directory');
      throw new Error('directory removal failed');
    });

    await expect(settleOrThrow([first, second], 'cleanup failed')).rejects.toMatchObject({
      errors: [expect.any(Error), expect.any(Error)],
    });
    expect(attempted).toEqual(['process', 'directory']);
  });
});
