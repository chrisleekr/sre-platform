import { expect, test, vi } from 'vitest';
import { makeDatadogConnector } from '../connector';
const triggered = Math.floor(Date.now() / 1000) - 600;
const resolved = triggered + 500;
function source(monitor: unknown) {
  const request = vi.fn(async () => Response.json(monitor));
  const connector = makeDatadogConnector(
    {
      id: 'read-monitor',
      tenantId: 'tenant',
      type: 'datadog',
      name: 'Datadog',
      settings: { site: 'datadoghq.com' },
      getCredential: async () => JSON.stringify({ apiKey: 'read-api-key', appKey: 'read-app-key' }),
    },
    request as unknown as typeof fetch,
  );
  return { connector, request };
}
test('reads one exact monitor group using both credentials and provider episode timestamps', async () => {
  const { connector, request } = source({
    id: 73,
    name: 'Checkout',
    state: {
      groups: {
        'host:checkout': { status: 'OK', last_triggered_ts: triggered, last_resolved_ts: resolved },
      },
    },
  });
  const result = await connector.alertLifecycle!.readEpisode!({
    monitorId: '73',
    scope: 'host:checkout',
    startsAt: new Date(triggered * 1000),
    observedAt: new Date(),
  });
  expect(result).toMatchObject({
    status: 'verified',
    observations: [
      {
        status: 'resolved',
        startsAt: new Date(triggered * 1000),
        endsAt: new Date(resolved * 1000),
      },
    ],
  });
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(new URL(url).pathname).toBe('/api/v1/monitor/73');
  expect(new URL(url).searchParams.get('group_states')).toBe('all');
  expect(new Headers(init.headers).get('DD-API-KEY')).toBe('read-api-key');
  expect(new Headers(init.headers).get('DD-APPLICATION-KEY')).toBe('read-app-key');
  expect(url).not.toContain('read-api-key');
});
test.each(['missing', 'refired', 'unknown', 'wrong_monitor'] as const)(
  'cannot infer recovery from %s current monitor evidence',
  async (scenario) => {
    const { connector } = source({
      id: scenario === 'wrong_monitor' ? 74 : 73,
      state: {
        groups:
          scenario === 'missing'
            ? {}
            : {
                'host:checkout': {
                  status: scenario === 'unknown' ? 'No Data' : 'OK',
                  last_triggered_ts: scenario === 'refired' ? triggered + 10 : triggered,
                  last_resolved_ts: resolved,
                },
              },
      },
    });
    expect(
      await connector.alertLifecycle!.readEpisode!({
        monitorId: '73',
        scope: 'host:checkout',
        startsAt: new Date(triggered * 1000),
        observedAt: new Date(),
      }),
    ).toMatchObject({ status: 'unverified' });
  },
);
test('native simple-monitor events support an empty scope without claiming an absent API group is recovered', async () => {
  const { connector } = source({ id: 73, overall_state: 'OK', state: { groups: {} } });
  expect(
    await connector.alertLifecycle!.normalizeEvent!({
      alert_id: '73',
      alert_scope: '',
      alert_cycle_key: 'simple-cycle',
      alert_transition: 'Triggered',
      date: String(triggered * 1000),
    }),
  ).toMatchObject({
    status: 'verified',
    observations: [{ status: 'firing', startsAt: new Date(triggered * 1000) }],
  });
  expect(
    await connector.alertLifecycle!.readEpisode!({
      monitorId: '73',
      scope: '',
      startsAt: new Date(triggered * 1000),
      observedAt: new Date(),
    }),
  ).toMatchObject({ status: 'unverified' });
});
const delivery = (changes: Record<string, unknown>) => ({
  alert_id: '73',
  alert_scope: 'host:checkout',
  alert_cycle_key: 'cycle-a',
  alert_transition: 'Triggered',
  date: String(triggered * 1000),
  ...changes,
});
test.each([
  ['Warn', {}],
  ['Re-Warn', {}],
  ['No Data', {}],
  ['Re-No Data', {}],
  ['A transition Datadog adds later', {}],
])(
  'a well-formed %s delivery is acknowledged, not reported as malformed (%#)',
  async (transition, extra) => {
    const { connector, request } = source({});
    expect(
      await connector.alertLifecycle!.normalizeEvent!(
        delivery({ alert_transition: transition, ...extra }),
      ),
    ).toEqual({ status: 'ignored', reason: 'transition_not_handled' });
    expect(request).not.toHaveBeenCalled();
  },
);
test.each([
  ['Re-Triggered', {}],
  ['Renotify', {}],
  // A repeat never opens a cycle, so the state it repeats does not matter.
  ['Renotify', { alert_type: 'warning' }],
])('%s is a repeat firing notice for the same cycle (%#)', async (transition, extra) => {
  const { connector } = source({});
  const repeated = await connector.alertLifecycle!.normalizeEvent!(
    delivery({ alert_transition: transition, ...extra }),
  );
  const original = await connector.alertLifecycle!.normalizeEvent!(delivery({}));
  expect(repeated).toMatchObject({
    status: 'verified',
    observations: [{ status: 'firing', repeatedTrigger: true }],
  });
  // Same cycle identity, so it lands on the original trigger's episode.
  if (repeated.status !== 'verified' || original.status !== 'verified')
    throw new Error('unverified');
  expect(repeated.observations[0]!.episodeKey).toBe(original.observations[0]!.episodeKey);
  expect(original.observations[0]).not.toHaveProperty('repeatedTrigger');
});
test.each([{ alert_transition: undefined }, { alert_transition: '' }, { alert_transition: 7 }])(
  'a delivery without a transition is malformed (%#)',
  async (changes) => {
    const { connector } = source({});
    expect(await connector.alertLifecycle!.normalizeEvent!(delivery(changes))).toEqual({
      status: 'unverified',
      reason: 'unsupported_event_schema',
    });
  },
);
