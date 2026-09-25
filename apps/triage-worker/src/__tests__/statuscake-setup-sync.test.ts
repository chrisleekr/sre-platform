import { beforeEach, expect, test, vi } from 'vitest';

// A plain function, not vi.fn: Vitest reports an error thrown through a vi.fn even after the code
// under test catches it.
const setup = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (): unknown => ({ status: 'synced', tests: [], changes: 0 }),
}));
vi.mock('@sre/agent-tools', () => ({
  runStatusCakeSetup: (...args: unknown[]) => {
    setup.calls.push(args);
    return setup.impl();
  },
}));
import { makeStatusCakeSetupSync } from '../statuscake-setup-sync';

const deps = { db: {} as never, secrets: {} as never };
beforeEach(() => {
  setup.calls = [];
  setup.impl = () => ({ status: 'synced', tests: [], changes: 0 });
});

test('runs at most once per five-minute window per connection and asks to skip connections that are off', async () => {
  const won = new Set<string>();
  const guardFor = (connectorId: string) => async (windowId: number, ttlSec: number) => {
    expect(ttlSec).toBe(300);
    const key = `${connectorId}:${windowId}`;
    if (won.has(key)) return false;
    won.add(key);
    return true;
  };
  let now = 0;
  const sync = makeStatusCakeSetupSync({ ...deps, guardFor }, () => now);
  await sync('tenant', 'a');
  await sync('tenant', 'a');
  await sync('tenant', 'b');
  expect(setup.calls.map((args) => args.slice(1))).toEqual([
    ['tenant', 'a', true, true],
    ['tenant', 'b', true, true],
  ]);
  now = 5 * 60_000;
  await sync('tenant', 'a');
  expect(setup.calls).toHaveLength(3);
});

test('a failed pass never throws into the poll job', async () => {
  const sync = makeStatusCakeSetupSync({ ...deps, guardFor: () => async () => true });
  setup.impl = () => Promise.reject(new Error('database gone'));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(sync('tenant', 'a')).resolves.toBeUndefined();
  expect(error).toHaveBeenCalledOnce();
  error.mockRestore();
});
