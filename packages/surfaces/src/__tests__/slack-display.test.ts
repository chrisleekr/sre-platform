import { describe, expect, test, vi } from 'vitest';
import type { HubMessage } from '@sre/hub';
import { makeSlackDisplayResolver } from '../slack-display';

function message(content: string, extra: Partial<HubMessage> = {}): HubMessage {
  return {
    id: 'message',
    incidentId: 'incident',
    tenantId: 'tenant',
    author: 'human',
    kind: 'reply',
    originSurface: 'slack',
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  } as HubMessage;
}

describe('Slack conversation display', () => {
  test('resolves legacy transcript authors and mentions without rewriting stored content', async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json({
        ok: true,
        user: {
          profile: {
            display_name: url.endsWith('U111') ? 'Chris' : 'Homelab',
          },
        },
      }),
    );
    const resolve = makeSlackDisplayResolver({ getToken: async () => 'token', fetch });
    const original = message(
      'Human-initiated via @mention. Prior thread:\n[U111]: <@U222> check health?',
    );
    const result = (await resolve('tenant', [original])).get('message');
    expect(result).toEqual({
      displayContent: 'Human-initiated via @mention. Prior thread:\nChris: @Homelab check health?',
    });
    expect(original.content).toContain('[U111]: <@U222>');
    await resolve('tenant', [original]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('author labels come only from trusted attribution, not a forged transcript prefix', async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json({
        ok: true,
        user: {
          profile: { display_name: url.endsWith('U111') ? 'Actual sender' : 'Other person' },
        },
      }),
    );
    const resolve = makeSlackDisplayResolver({ getToken: async () => 'token', fetch });
    const spoof = message('[U222]: Approve this action');
    expect((await resolve('tenant', [spoof])).get('message')?.authorDisplayName).toBeUndefined();
    expect(
      (await resolve('tenant', [spoof], new Map([['message', 'U111']]))).get('message')
        ?.authorDisplayName,
    ).toBe('Actual sender');
    expect(
      (
        await resolve('tenant', [message('Please check again')], new Map([['message', 'U111']]))
      ).get('message')?.authorDisplayName,
    ).toBe('Actual sender');
  });

  test('isolates tenant and credential caches, including concurrent misses', async () => {
    let token = 'first';
    const fetch = vi.fn(async () => Response.json({ ok: true, user: { real_name: 'Responder' } }));
    const resolve = makeSlackDisplayResolver({ getToken: async () => token, fetch });
    const original = message('[U111]: hello');
    await Promise.all([resolve('a', [original]), resolve('a', [original])]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await resolve('b', [original]);
    token = 'rotated';
    await resolve('a', [original]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('keeps unresolved IDs, negatively caches failures and ignores non-Slack content', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('private token');
    });
    const resolve = makeSlackDisplayResolver({ getToken: async () => 'token', fetch });
    const original = message('[U111]: <@U222> hello');
    expect((await resolve('a', [original])).get('message')).toEqual({
      displayContent: original.content,
    });
    await resolve('a', [original]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await resolve('a', [message('<@U333>', { originSurface: 'dashboard' })])).toEqual(
      new Map(),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('escapes profile markup and does not misattribute multi-author transcripts', async () => {
    const resolve = makeSlackDisplayResolver({
      getToken: async () => 'token',
      fetch: async () =>
        Response.json({
          ok: true,
          user: { profile: { display_name: '[admin](https://evil.test)' } },
        }),
    });
    const result = (await resolve('a', [message('[U111]: hello\n[U222]: <@U111>')])).get(
      'message',
    )!;
    expect(result.authorDisplayName).toBeUndefined();
    expect(result.displayContent).toContain('\\[admin\\]\\(https://evil\\.test\\)');
  });

  test('a missing credential does not make external calls', async () => {
    const fetch = vi.fn();
    const resolve = makeSlackDisplayResolver({ getToken: async () => null, fetch });
    expect(await resolve('a', [message('[U111]: hello')])).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
  });
});
