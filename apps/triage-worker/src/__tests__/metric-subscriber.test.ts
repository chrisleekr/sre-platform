// Pure-unit (no Postgres/Valkey/ConversationHub): the metric subscriber polls an injected
// MetricSource and posts to a narrow HubAppendPort only on a >= threshold move. Fake source +
// spy hub; timer behaviour driven with vi fake timers so nothing depends on real wall-clock.
// Real source + worker-lifecycle wiring are deferred to the connector poller / k8s.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MetricSubscriber,
  MetricSubscriberManager,
  METRIC_DELTA_THRESHOLD,
  METRIC_POLL_INTERVAL_MS,
} from '../metric-subscriber';
import type { HubAppendPort, MetricSource } from '../metric-subscriber';

const TENANT = 'tenant-1';
const INCIDENT = 'incident-1';
const SERVICE = 'checkout';

type AppendMsg = Parameters<HubAppendPort['append']>[2];
type AppendCall = { tenantId: string; incidentId: string; msg: AppendMsg };

// Records every append so a case can assert exactly what (and whether) the subscriber posted.
function spyHub(): { hub: HubAppendPort; calls: AppendCall[] } {
  const calls: AppendCall[] = [];
  const hub: HubAppendPort = {
    append(tenantId, incidentId, msg) {
      calls.push({ tenantId, incidentId, msg });
      return Promise.resolve();
    },
  };
  return { hub, calls };
}

// Returns the scripted readings in order, then repeats the last one (a poller never stops reading).
function scriptedSource(readings: ReadonlyArray<Record<string, number>>): MetricSource {
  let i = 0;
  return {
    read() {
      const r = readings[Math.min(i, readings.length - 1)] ?? {};
      i += 1;
      return Promise.resolve(r);
    },
  };
}

function makeSubscriber(source: MetricSource, hub: HubAppendPort): MetricSubscriber {
  return new MetricSubscriber({
    tenantId: TENANT,
    incidentId: INCIDENT,
    service: SERVICE,
    source,
    hub,
  });
}

describe('MetricSubscriber.tick', () => {
  test('exposes the threshold and poll interval contract', () => {
    expect(METRIC_DELTA_THRESHOLD).toBe(0.2);
    expect(METRIC_POLL_INTERVAL_MS).toBe(10_000);
  });

  test('a move at/above threshold posts one system/text message naming the metric and values', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 0.4 }, { cpu: 0.54 }]), hub);

    await sub.tick(); // first reading seeds the baseline, posts nothing
    expect(calls).toHaveLength(0);

    await sub.tick(); // 0.40 -> 0.54 is +35%, past the 20% threshold
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.tenantId).toBe(TENANT);
    expect(call.incidentId).toBe(INCIDENT);
    expect(call.msg.author).toBe('system');
    expect(call.msg.kind).toBe('text');
    expect(call.msg.content).toContain('cpu');
    expect(call.msg.content).toContain('+35%');
    expect(call.msg.content).toContain('0.40');
    expect(call.msg.content).toContain('0.54');
    expect(call.msg.content).toContain(SERVICE);
  });

  test('a move exactly at the threshold posts (boundary is inclusive, >=)', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 10 }, { cpu: 12 }]), hub);

    await sub.tick(); // seed 10
    await sub.tick(); // 10 -> 12 is exactly +20%
    expect(calls).toHaveLength(1);
    expect(calls[0]!.msg.content).toContain('+20%');
  });

  test('a move below the threshold posts nothing', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 10 }, { cpu: 11 }]), hub);

    await sub.tick(); // seed 10
    await sub.tick(); // 10 -> 11 is +10%, below threshold
    expect(calls).toHaveLength(0);
  });

  test('the first tick seeds the baseline (no post) so a later move is measured against it', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 10 }, { cpu: 20 }]), hub);

    await sub.tick(); // seed 10
    expect(calls).toHaveLength(0);
    await sub.tick(); // 10 -> 20 is +100%
    expect(calls).toHaveLength(1);
  });

  test('a zero baseline does not divide-by-zero: it seeds, then the next non-zero move is measured', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 0 }, { cpu: 5 }, { cpu: 7 }]), hub);

    await sub.tick(); // seed 0
    await sub.tick(); // prev === 0: no delta calc, just reseed to 5
    expect(calls).toHaveLength(0);
    await sub.tick(); // 5 -> 7 is +40%
    expect(calls).toHaveLength(1);
    expect(calls[0]!.msg.content).toContain('+40%');
  });

  test('metrics are tracked independently: only the one that moved is posted', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(
      scriptedSource([
        { cpu: 0.4, mem: 0.5 },
        { cpu: 0.54, mem: 0.51 }, // cpu +35% posts, mem +2% does not
      ]),
      hub,
    );

    await sub.tick(); // seed both
    await sub.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.msg.content).toContain('cpu');
    expect(calls[0]!.msg.content).not.toContain('mem');
  });

  test('a custom threshold overrides the default', async () => {
    const { hub, calls } = spyHub();
    const sub = new MetricSubscriber({
      tenantId: TENANT,
      incidentId: INCIDENT,
      service: SERVICE,
      source: scriptedSource([{ cpu: 10 }, { cpu: 14 }]), // +40%
      hub,
      threshold: 0.5, // 40% is below 50%, so nothing posts
    });

    await sub.tick();
    await sub.tick();
    expect(calls).toHaveLength(0);
  });
});

describe('MetricSubscriber start/stop', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('start toggles the running flag, is idempotent, and stop halts polling', async () => {
    const { hub, calls } = spyHub();
    const sub = makeSubscriber(scriptedSource([{ cpu: 1 }, { cpu: 2 }, { cpu: 4 }]), hub);

    expect(sub.running).toBe(false);
    sub.start(10);
    expect(sub.running).toBe(true);
    sub.start(10); // idempotent: must not schedule a second interval
    expect(sub.running).toBe(true);

    await vi.advanceTimersByTimeAsync(10); // one tick: seed cpu=1 (a duplicate interval would post here)
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10); // one tick: 1 -> 2 posts once
    expect(calls).toHaveLength(1);

    sub.stop();
    expect(sub.running).toBe(false);
    await vi.advanceTimersByTimeAsync(100); // interval cleared: no further posts
    expect(calls).toHaveLength(1);
  });
});

describe('MetricSubscriberManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test('subscribe is idempotent: at most one subscriber per incident', () => {
    const { hub } = spyHub();
    const manager = new MetricSubscriberManager({ source: scriptedSource([{ cpu: 1 }]), hub });

    manager.subscribe({ tenantId: TENANT, incidentId: INCIDENT, service: SERVICE });
    manager.subscribe({ tenantId: TENANT, incidentId: INCIDENT, service: SERVICE });

    expect(manager.size()).toBe(1);
    expect(manager.has(INCIDENT)).toBe(true);
    manager.stopAll();
    expect(manager.size()).toBe(0);
  });

  test('distinct incidents are tracked independently', () => {
    const { hub } = spyHub();
    const manager = new MetricSubscriberManager({ source: scriptedSource([{ cpu: 1 }]), hub });

    manager.subscribe({ tenantId: TENANT, incidentId: 'incident-A', service: SERVICE });
    manager.subscribe({ tenantId: TENANT, incidentId: 'incident-B', service: SERVICE });

    expect(manager.size()).toBe(2);
    expect(manager.has('incident-A')).toBe(true);
    expect(manager.has('incident-B')).toBe(true);
    manager.stopAll();
  });

  test('unsubscribe clears the interval: no hub.append after teardown', async () => {
    const { hub, calls } = spyHub();
    const source = scriptedSource([{ cpu: 1 }, { cpu: 2 }, { cpu: 4 }, { cpu: 8 }]);
    const manager = new MetricSubscriberManager({ source, hub });
    manager.subscribe({ tenantId: TENANT, incidentId: INCIDENT, service: SERVICE });
    expect(manager.has(INCIDENT)).toBe(true);

    await vi.advanceTimersByTimeAsync(METRIC_POLL_INTERVAL_MS); // tick: seed
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(METRIC_POLL_INTERVAL_MS); // tick: 1 -> 2 posts
    expect(calls).toHaveLength(1);

    manager.unsubscribe(INCIDENT);
    expect(manager.has(INCIDENT)).toBe(false);
    expect(manager.size()).toBe(0);

    await vi.advanceTimersByTimeAsync(METRIC_POLL_INTERVAL_MS * 5); // no further ticks
    expect(calls).toHaveLength(1);
  });

  test('unsubscribe of an unknown incident is a no-op', () => {
    const { hub } = spyHub();
    const manager = new MetricSubscriberManager({ source: scriptedSource([{ cpu: 1 }]), hub });
    expect(() => manager.unsubscribe('nope')).not.toThrow();
    expect(manager.size()).toBe(0);
  });
});
