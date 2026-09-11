import { describe, expect, test, vi } from 'vitest';

import { createFixture } from './hub.fixture';

const __fixture = createFixture();

// A subscription owns a duplicated Valkey connection, so releasing it is the only thing that returns
// that connection. These tests pin the release itself rather than message delivery.
describe('ConversationHub subscription release', () => {
  // Releasing runs from several session paths (normal close, the token-expiry timer, the error unwind)
  // and more than one can fire for the same subscription, so the release must survive a repeat call.
  test('unsubscribe is idempotent and leaves the duplicated connection released', async () => {
    const duplicate = vi.spyOn(__fixture.redis, 'duplicate');
    try {
      const unsubscribe = await __fixture.hub.subscribe(__fixture.incidentId, () => undefined);
      const sub = duplicate.mock.results[0]!.value;
      const ended = new Promise<void>((resolve) => {
        sub.once('end', () => resolve());
      });

      await unsubscribe();
      await expect(unsubscribe()).resolves.toBeUndefined();

      await ended;
      expect(sub.status).toBe('end');
    } finally {
      duplicate.mockRestore();
    }
  });

  // The unsubscribe command can fail exactly when Valkey is unreachable, which is when leaking the
  // duplicated connection for the process lifetime hurts most.
  test('a failing unsubscribe still releases the duplicated connection', async () => {
    const unreachable = new Error('Valkey unreachable');
    const duplicate = vi.spyOn(__fixture.redis, 'duplicate');
    try {
      const unsubscribe = await __fixture.hub.subscribe(__fixture.incidentId, () => undefined);
      const sub = duplicate.mock.results[0]!.value;
      const ended = new Promise<void>((resolve) => {
        sub.once('end', () => resolve());
      });
      vi.spyOn(sub, 'unsubscribe').mockImplementation(() => Promise.reject(unreachable));

      await expect(unsubscribe()).rejects.toBe(unreachable);

      await ended;
      expect(sub.status).toBe('end');
    } finally {
      duplicate.mockRestore();
    }
  });
});
