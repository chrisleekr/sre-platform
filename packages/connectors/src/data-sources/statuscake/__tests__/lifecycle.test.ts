import { describe, expect, test, vi } from 'vitest';
import { statusCakeLifecycle } from '../lifecycle';

const start = new Date('2026-09-21T01:00:00Z');
const trigger = new Date('2026-09-21T01:00:30Z');
const end = new Date('2026-09-21T01:20:00Z');
const check = {
  data: {
    id: '42',
    status: 'up',
    paused: false,
    name: 'Checkout',
    website_url: 'https://same.example',
  },
};

test('completed period timing corroborates the existing trigger reference without changing episode identity', async () => {
  const read = vi.fn(async (path: string) =>
    path.endsWith('/periods')
      ? {
          data: [{ status: 'down', created_at: start.toISOString(), ended_at: end.toISOString() }],
          links: {},
        }
      : check,
  );
  const result = await statusCakeLifecycle(read).readEpisode!({
    family: 'uptime',
    monitorId: '42',
    startsAt: trigger,
    observedAt: new Date('2026-09-21T02:00:00Z'),
  });
  expect(result).toMatchObject({
    status: 'verified',
    observations: [
      {
        status: 'resolved',
        startsAt: trigger,
        endsAt: end,
        annotations: { provider_period_started_at: start.toISOString() },
      },
    ],
  });
  expect(read).toHaveBeenCalledWith('/v1/uptime/42/periods', { limit: 100 });
});

test.each(['ssl', 'heartbeat', 'pagespeed'])(
  '%s lifecycle is explicitly unsupported',
  async (family) => {
    const read = vi.fn();
    expect(
      await statusCakeLifecycle(read).readEpisode!({
        family,
        monitorId: '42',
        observedAt: trigger,
      }),
    ).toMatchObject({ status: 'unverified', reason: 'unsupported_check_family' });
    expect(read).not.toHaveBeenCalled();
  },
);

test('same URL does not establish monitor identity', async () => {
  const read = vi.fn(async () => ({ data: { ...check.data, id: '43' } }));
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      observedAt: trigger,
    }),
  ).toMatchObject({ status: 'unverified', reason: 'monitor_identity_mismatch' });
});

test.each([
  { data: [], links: {} },
  { data: [{ status: 'down', created_at: start.toISOString(), ended_at: 'bad-date' }], links: {} },
  { data: [] },
  { data: [], links: { next: 'https://evil.example/v1/uptime/42/periods?before=1' } },
  { data: [], links: { next: 'https://api.statuscake.com/v1/uptime/43/periods?before=1' } },
])('missing or malformed period evidence cannot assert recovery: %j', async (response) => {
  const read = vi.fn(async (path: string) => (path.endsWith('/periods') ? response : check));
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      startsAt: trigger,
      observedAt: end,
    }),
  ).toMatchObject({ status: 'unverified' });
});

test('bounded history exhaustion does not claim an older period recovered', async () => {
  let page = 0;
  const read = vi.fn(async (path: string) =>
    path.endsWith('/periods')
      ? {
          data: [],
          links: {
            next: `https://api.statuscake.com/v1/uptime/42/periods?before=${10000 - ++page}`,
          },
        }
      : check,
  );
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      startsAt: trigger,
      observedAt: end,
    }),
  ).toMatchObject({ status: 'unverified', reason: 'history_window_exhausted' });
  expect(page).toBe(5);
});

test('permission and transport errors remain unverified without exposing upstream secrets', async () => {
  const read = vi.fn(async () => {
    throw new Error('secret-bearer-token: upstream denied');
  });
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      observedAt: trigger,
    }),
  ).toEqual({ status: 'unverified', reason: 'provider_read_failed' });
});

test('current Up with no new episode completes a wakeup without asserting any recovery', async () => {
  const read = vi.fn(async (path: string) =>
    path.endsWith('/periods') ? { data: [], links: {} } : check,
  );
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      observedAt: end,
    }),
  ).toEqual({ status: 'verified', observations: [] });
});
test('current Down with missing alert history cannot be mistaken for a completed empty wakeup', async () => {
  const read = vi.fn(async (path: string) =>
    path.endsWith('/periods') || path.endsWith('/alerts')
      ? { data: [], links: {} }
      : { data: { ...check.data, status: 'down' } },
  );
  expect(
    await statusCakeLifecycle(read).readEpisode!({
      family: 'uptime',
      monitorId: '42',
      observedAt: end,
    }),
  ).toMatchObject({ status: 'unverified', reason: 'episode_not_retained' });
});

describe('monitorForSubject', () => {
  const subject = 'statuscake:uptime:https://chrislee.kr/';
  const inventory = (pages: Array<Array<{ id: unknown; website_url: string }>>) =>
    vi.fn(async (_path: string, query?: Record<string, string | number>) => {
      const page = Number(query?.page);
      return { data: pages[page - 1] ?? [], metadata: { page_count: pages.length } };
    });
  const match = (read: ReturnType<typeof inventory>, groupKey = subject) =>
    statusCakeLifecycle(read).monitorForSubject!(groupKey);

  test('selects the one test whose URL serialises identically', async () => {
    const read = inventory([
      [
        { id: 7, website_url: 'HTTPS://Chrislee.KR' },
        { id: 8, website_url: 'http://chrislee.kr' },
        { id: 9, website_url: 'https://chrislee.kr/health' },
        { id: 10, website_url: 'https://chrislee.kr:8443' },
      ],
    ]);
    expect(await match(read)).toEqual({ status: 'matched', monitorId: '7', family: 'uptime' });
    expect(read).toHaveBeenCalledWith('/v1/uptime', { page: 1, limit: 100 });
  });

  test('reads every page before claiming uniqueness', async () => {
    const read = inventory([
      [{ id: '7', website_url: 'https://chrislee.kr' }],
      [{ id: '11', website_url: 'https://chrislee.kr/' }],
    ]);
    expect(await match(read)).toEqual({ status: 'unmatched', reason: 'ambiguous_monitor' });
    expect(read).toHaveBeenCalledTimes(2);
  });

  test('no test for the URL is reported as such', async () => {
    expect(await match(inventory([[{ id: '7', website_url: 'https://other.example' }]]))).toEqual({
      status: 'unmatched',
      reason: 'no_matching_monitor',
    });
    expect(await match(inventory([]))).toEqual({
      status: 'unmatched',
      reason: 'no_matching_monitor',
    });
  });

  test('an inventory beyond five pages or an unreadable one proves nothing', async () => {
    const pages = Array.from({ length: 6 }, (_, index) => [
      { id: String(index), website_url: index === 0 ? 'https://chrislee.kr' : 'https://x.example' },
    ]);
    expect(await match(inventory(pages))).toEqual({
      status: 'unmatched',
      reason: 'inventory_unavailable',
    });
    const failing = vi.fn(async () => {
      throw new Error('statuscake api 500');
    });
    expect(await statusCakeLifecycle(failing).monitorForSubject!(subject)).toEqual({
      status: 'unmatched',
      reason: 'inventory_unavailable',
    });
  });

  test.each(['statuscake:ssl:https://chrislee.kr/', 'statuscake:uptime:not a url', 'checkout'])(
    'rejects %s without reading the provider',
    async (groupKey) => {
      const read = inventory([]);
      expect(await match(read, groupKey)).toEqual({
        status: 'unmatched',
        reason: 'unsupported_subject',
      });
      expect(read).not.toHaveBeenCalled();
    },
  );
});
