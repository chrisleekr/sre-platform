import { describe, expect, test, vi } from 'vitest';
import { makeGitHubSmeeManager } from '../github-smee';

describe('GitHubSmeeManager', () => {
  test('starts, replaces, and stops one secret-free relay per data source', async () => {
    const clients: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const configurations: unknown[] = [];
    const log = { info: vi.fn(), error: vi.fn() };
    const manager = makeGitHubSmeeManager({
      port: 43000,
      log,
      createClient: (options) => {
        configurations.push(options);
        const client = { start: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
        clients.push(client);
        return client;
      },
    });

    await manager.replace('tenant-a', 'source-a', 'https://smee.io/first', 'first-key');
    await manager.replace('tenant-a', 'source-a', 'https://smee.io/first', 'first-key');
    await manager.replace('tenant-a', 'source-a', 'https://smee.io/second', 'second-key');
    await manager.stop('source-a');

    expect(configurations).toHaveLength(2);
    expect(configurations[0]).toMatchObject({
      source: 'https://smee.io/first',
      target: 'http://127.0.0.1:43000/webhooks/github/first-key',
      maxConnectionTimeout: 8_000,
    });
    expect(clients[0]!.start).toHaveBeenCalledTimes(1);
    expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
    expect(clients[1]!.stop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.info.mock.calls, log.error.mock.calls])).not.toContain('smee.io');
  });

  test('keeps multiple relays for the same tenant independent', async () => {
    const clients: Array<{ start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }> = [];
    const manager = makeGitHubSmeeManager({
      port: 43000,
      log: { info: vi.fn(), error: vi.fn() },
      createClient: () => {
        const client = { start: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
        clients.push(client);
        return client;
      },
    });

    await manager.replace('tenant-a', 'source-a', 'https://smee.io/first', 'first-key');
    await manager.replace('tenant-a', 'source-b', 'https://smee.io/second', 'second-key');
    await manager.stop('source-a');

    expect(clients[0]!.stop).toHaveBeenCalledTimes(1);
    expect(clients[1]!.stop).not.toHaveBeenCalled();
    await manager.stopAll();
    expect(clients[1]!.stop).toHaveBeenCalledTimes(1);
  });

  test('keeps the current relay when its replacement cannot connect', async () => {
    const first = { start: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
    const failed = {
      start: vi.fn(async () => {
        throw new Error('offline');
      }),
      stop: vi.fn(async () => {}),
    };
    const createClient = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(failed);
    const manager = makeGitHubSmeeManager({
      port: 43000,
      log: { info: vi.fn(), error: vi.fn() },
      createClient,
    });

    await manager.replace('tenant-a', 'source-a', 'https://smee.io/first', 'first-key');
    await expect(
      manager.replace('tenant-a', 'source-a', 'https://smee.io/second', 'second-key'),
    ).rejects.toThrow('offline');
    await manager.stop('source-a');

    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(failed.stop).toHaveBeenCalledTimes(1);
  });

  test('rejects a non-Smee source before constructing a client', async () => {
    const createClient = vi.fn();
    const manager = makeGitHubSmeeManager({
      port: 43000,
      log: { info: vi.fn(), error: vi.fn() },
      createClient,
    });

    await expect(
      manager.replace('tenant-a', 'source-a', 'https://example.com/channel', 'key'),
    ).rejects.toThrow(/smee\.io/);
    expect(createClient).not.toHaveBeenCalled();
  });
});
