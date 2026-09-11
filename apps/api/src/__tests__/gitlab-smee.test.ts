import { describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import SmeeClient from 'smee-client';
import { makeGitLabSmeeManager } from '../gitlab-smee';
import { validSigningTokenRequest } from '../gitlab-webhook/mapping';

describe('GitLabSmeeManager', () => {
  test.each([
    ['compact JSON', '{"event_name":"project_create","name":"checkout"}', 'valid'],
    ['formatted JSON', '{\n  "event_name": "project_create"\n}', 'invalid'],
    ['escaped Unicode', '{"name":"\\u00a3"}', 'invalid'],
  ])('preserves signature enforcement through the real relay for %s', async (_, raw, expected) => {
    const key = Buffer.alloc(32, 7);
    const token = `whsec_${key.toString('base64')}`;
    const id = 'relay-delivery';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v1,${createHmac('sha256', key)
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64')}`;
    const envelope = {
      body: JSON.parse(raw),
      query: {},
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': signature,
      'x-gitlab-event': 'System Hook',
    };
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const forwarded: Array<{ body: string; result: string }> = [];
    const log = { info: vi.fn(), error: vi.fn() };
    const manager = makeGitLabSmeeManager({
      port: 43000,
      log,
      createClient: (options) =>
        new SmeeClient({
          ...options,
          fetch: async (_url: unknown, init: RequestInit) => {
            if (init.method !== 'POST') {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    stream = controller;
                  },
                }),
                { headers: { 'content-type': 'text/event-stream' } },
              );
            }
            const headers = new Headers(init.headers);
            const body = String(init.body);
            const result = validSigningTokenRequest(
              token,
              headers.get('webhook-id')!,
              headers.get('webhook-timestamp')!,
              body,
              headers.get('webhook-signature')!,
            );
            forwarded.push({ body, result });
            return new Response(null, { status: result === 'valid' ? 200 : 401 });
          },
        }),
    });
    try {
      await manager.replace('tenant-a', 'source-a', 'https://smee.io/test-channel', 'opaque-key');
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(envelope)}\n\n`));
      await vi.waitFor(() => expect(forwarded).toHaveLength(1));
      expect(forwarded[0]).toEqual({ body: JSON.stringify(envelope.body), result: expected });
      expect(log.error).not.toHaveBeenCalled();
    } finally {
      await manager.stopAll();
      stream.close();
    }
  });

  test('forwards to the tenant GitLab webhook without logging the channel URL', async () => {
    const client = { start: vi.fn(async () => ({})), stop: vi.fn(async () => {}) };
    const configurations: unknown[] = [];
    const log = { info: vi.fn(), error: vi.fn() };
    const manager = makeGitLabSmeeManager({
      port: 43000,
      log,
      createClient: (options) => {
        configurations.push(options);
        return client;
      },
    });

    await manager.replace('tenant-a', 'source-a', 'https://smee.io/gitlab-channel', 'opaque-key');
    await manager.stopAll();

    expect(configurations).toMatchObject([
      {
        source: 'https://smee.io/gitlab-channel',
        target: 'http://127.0.0.1:43000/webhooks/gitlab/opaque-key',
        maxConnectionTimeout: 8_000,
      },
    ]);
    expect(client.start).toHaveBeenCalledTimes(1);
    expect(client.stop).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([log.info.mock.calls, log.error.mock.calls])).not.toContain('smee.io');
  });
});
