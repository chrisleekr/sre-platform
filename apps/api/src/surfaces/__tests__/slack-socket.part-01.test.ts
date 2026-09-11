import { describe, expect, test, vi } from 'vitest';

import { createFixture } from './slack-socket.fixture';

const __fixture = createFixture();

describe('Slack Socket Mode manager', () => {
  test('derives the Slack app id only from the documented xapp-1 token shape', async () => {
    const { slackAppIdFromToken } = await import('../slack-socket');

    expect(slackAppIdFromToken('xapp-1-AAPP262-token-secret')).toBe('AAPP262');
    expect(slackAppIdFromToken('xapp-AAPP262-token-secret')).toBeUndefined();
    expect(slackAppIdFromToken('xoxb-1-AAPP262-token-secret')).toBeUndefined();
  });

  test('starts configured clients, replaces a rotated client, and closes every active client', async () => {
    const first = new __fixture.FakeSocketClient();
    const replacement = new __fixture.FakeSocketClient();
    const second = new __fixture.FakeSocketClient();
    const clients = [first, second, replacement];
    const createClient = vi.fn((_appToken: string) => clients.shift()!);
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        listConnections: async () => [
          { configId: 'cfg-a', appToken: 'xapp-a', appId: __fixture.APP_A },
          { configId: 'cfg-b', appToken: 'xapp-b', appId: __fixture.APP_A },
        ],
        createClient,
      }),
    );

    await manager.startAll();
    expect(createClient.mock.calls.map((call) => call[0])).toEqual(['xapp-a', 'xapp-b']);
    expect(first.start).toHaveBeenCalledTimes(1);
    expect(second.start).toHaveBeenCalledTimes(1);
    expect(manager.status('cfg-a').state).toBe('connected');

    await manager.replace('cfg-a', 'xapp-a-rotated', __fixture.APP_A);
    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    await manager.stopAll();
    expect(replacement.disconnect).toHaveBeenCalledTimes(1);
    expect(second.disconnect).toHaveBeenCalledTimes(1);
    expect(manager.status('cfg-a').state).toBe('disconnected');
  });

  test('routes events by the envelope team, then acknowledges only after processing completes', async () => {
    const client = new __fixture.FakeSocketClient();
    let finish!: () => void;
    const processing = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const route = { configId: 'cfg-team-b', tenantId: 'tenant-b', appId: __fixture.APP_A };
    const resolveTeam = vi.fn(async () => route);
    const processEvent = vi.fn(async () => processing);
    const ack = vi.fn(async () => {});
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({ createClient: () => client, resolveTeam, processEvent }),
    );
    await manager.replace('cfg-client-a', 'xapp-a', __fixture.APP_A);

    const delivery = client.receive(__fixture.eventsEnvelope('T-B', ack));
    await vi.waitFor(() => expect(processEvent).toHaveBeenCalledTimes(1));
    expect(resolveTeam).toHaveBeenCalledWith('T-B', __fixture.APP_A);
    expect(processEvent).toHaveBeenCalledWith(route, expect.objectContaining({ team_id: 'T-B' }));
    expect(ack).not.toHaveBeenCalled();

    finish();
    await delivery;
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('routes across clients only when the receiving client, envelope, and routed config share one app', async () => {
    const client = new __fixture.FakeSocketClient();
    const route = { configId: 'cfg-workspace-b', tenantId: 'tenant-b', appId: __fixture.APP_A };
    const processEvent = vi.fn(async () => 'classify_enqueued');
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => route,
        processEvent,
      }),
    );
    await manager.replace('cfg-receiving-client-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-WORKSPACE-B', undefined, __fixture.APP_A));

    expect(processEvent).toHaveBeenCalledWith(route, expect.any(Object));
  });

  test('drops a cross-app envelope before team routing and acknowledges without side effects', async () => {
    const client = new __fixture.FakeSocketClient();
    const resolveTeam = vi.fn(async () => ({
      configId: 'cfg-b',
      tenantId: 'tenant-b',
      appId: __fixture.APP_B,
    }));
    const processEvent = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const onEvent = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({ createClient: () => client, resolveTeam, processEvent, onEvent }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-B', ack, __fixture.APP_B));

    expect(resolveTeam).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'drop', reason: 'app_mismatch' }),
    );
  });

  test('drops when the globally routed config belongs to a different app', async () => {
    const client = new __fixture.FakeSocketClient();
    const processEvent = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => ({
          configId: 'cfg-b',
          tenantId: 'tenant-b',
          appId: __fixture.APP_B,
        }),
        processEvent,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-B', ack, __fixture.APP_A));

    expect(processEvent).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('leaves a failed known-team event unacknowledged so Slack can retry', async () => {
    const client = new __fixture.FakeSocketClient();
    const ack = vi.fn(async () => {});
    const onError = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => ({
          configId: 'cfg-a',
          tenantId: 'tenant-a',
          appId: __fixture.APP_A,
        }),
        processEvent: async () => {
          throw new Error('durable enqueue failed');
        },
        onError,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-A', ack));

    expect(ack).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('acknowledges an unknown team without tenant side effects or an infinite retry', async () => {
    const client = new __fixture.FakeSocketClient();
    const processEvent = vi.fn(async () => {});
    const processInteraction = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({ createClient: () => client, processEvent, processInteraction }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-UNKNOWN', ack));

    expect(processEvent).not.toHaveBeenCalled();
    expect(processInteraction).not.toHaveBeenCalled();
    expect(ack).toHaveBeenCalledTimes(1);
  });

  test('routes block_actions by team and acknowledges after the approval processor completes', async () => {
    const client = new __fixture.FakeSocketClient();
    const route = { configId: 'cfg-a', tenantId: 'tenant-a', appId: __fixture.APP_A };
    const processInteraction = vi.fn(async () => {});
    const ack = vi.fn(async () => {});
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => route,
        processInteraction,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.interactiveEnvelope('T-A', ack));

    expect(processInteraction).toHaveBeenCalledWith(
      route,
      expect.objectContaining({ type: 'block_actions' }),
    );
    expect(ack).toHaveBeenCalledTimes(1);
    expect(Number(processInteraction.mock.invocationCallOrder[0])).toBeLessThan(
      Number(ack.mock.invocationCallOrder[0]),
    );
  });

  test('routes every interactive envelope through durable processing before acknowledging it', async () => {
    const client = new __fixture.FakeSocketClient();
    const route = { configId: 'cfg-a', tenantId: 'tenant-a', appId: __fixture.APP_A };
    const processInteraction = vi.fn(async () => 'dropped_no_candidate');
    const ack = vi.fn(async () => {});
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => route,
        processInteraction,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive({
      ...__fixture.interactiveEnvelope('T-A', ack),
      body: {
        type: 'view_submission',
        api_app_id: __fixture.APP_A,
        team: { id: 'T-A' },
      },
    });

    expect(processInteraction).toHaveBeenCalledWith(
      route,
      expect.objectContaining({ type: 'view_submission' }),
    );
    expect(Number(processInteraction.mock.invocationCallOrder[0])).toBeLessThan(
      Number(ack.mock.invocationCallOrder[0]),
    );
  });

  test('leaves an interactive envelope unacknowledged when durable processing fails', async () => {
    const client = new __fixture.FakeSocketClient();
    const route = { configId: 'cfg-a', tenantId: 'tenant-a', appId: __fixture.APP_A };
    const ack = vi.fn(async () => {});
    const onError = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => route,
        processInteraction: async () => {
          throw new Error('durable interaction enqueue failed');
        },
        onError,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive({
      ...__fixture.interactiveEnvelope('T-A', ack),
      body: {
        type: 'view_submission',
        api_app_id: __fixture.APP_A,
        team: { id: 'T-A' },
      },
    });

    expect(ack).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  test('C15 emits secret-free receive, verified route, and terminal processor outcome events', async () => {
    const appToken = 'xapp-secret-must-not-be-logged';
    const attachmentText = 'credential-looking attachment content';
    const client = new __fixture.FakeSocketClient();
    const onEvent = vi.fn();
    const route = { configId: 'cfg-a', tenantId: 'tenant-a', appId: __fixture.APP_A };
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => route,
        processEvent: async () => 'classify_enqueued',
        onEvent,
      }),
    );
    await manager.replace('cfg-a', appToken, __fixture.APP_A);

    await client.receive({
      type: 'events_api',
      body: {
        team_id: 'T-A',
        api_app_id: __fixture.APP_A,
        event_id: 'Ev-attachment',
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C-A',
          ts: '262.2',
          text: '',
          attachments: [{ fallback: attachmentText }],
        },
      },
      ack: vi.fn(async () => {}),
    });

    const emitted = onEvent.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(emitted.map((event) => event.stage)).toEqual(['receive', 'route', 'outcome']);
    expect(emitted[0]).toMatchObject({
      stage: 'receive',
      eventId: 'Ev-attachment',
      eventType: 'message',
      eventSubtype: 'bot_message',
      channel: 'C-A',
    });
    expect(emitted[1]).toMatchObject({
      stage: 'route',
      envelopeType: 'events_api',
      teamId: 'T-A',
      configId: 'cfg-a',
      tenantId: 'tenant-a',
    });
    expect(emitted[2]).toMatchObject({
      stage: 'outcome',
      outcome: 'classify_enqueued',
      acknowledged: true,
    });
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain(appToken);
    expect(serialized).not.toContain(attachmentText);
    expect(serialized).not.toContain('"attachments"');
    expect(serialized).not.toContain('"text"');
    expect(serialized).not.toContain('"body"');
    expect(serialized).not.toContain('"payload"');
    expect(serialized).not.toContain('262.2');
  });

  test('C15 emits an explicit unknown-team drop reason and acknowledged terminal outcome', async () => {
    const client = new __fixture.FakeSocketClient();
    const onEvent = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(__fixture.deps({ createClient: () => client, onEvent }));
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive(__fixture.eventsEnvelope('T-UNKNOWN'));

    const emitted = onEvent.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(emitted.map((event) => event.stage)).toEqual(['receive', 'drop', 'outcome']);
    expect(emitted[1]).toMatchObject({
      stage: 'drop',
      envelopeType: 'events_api',
      teamId: 'T-UNKNOWN',
      reason: 'unknown_team',
    });
    expect(emitted[2]).toMatchObject({ stage: 'outcome', acknowledged: true });
  });

  test('C15/C16 emits a secret-free failed outcome and leaves attachment enqueue failure unacknowledged', async () => {
    const secretText = 'xoxb-secret-from-downstream-error';
    const client = new __fixture.FakeSocketClient();
    const ack = vi.fn(async () => {});
    const onEvent = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => client,
        resolveTeam: async () => ({
          configId: 'cfg-a',
          tenantId: 'tenant-a',
          appId: __fixture.APP_A,
        }),
        processEvent: async () => {
          throw new Error(`classify enqueue failed: ${secretText}`);
        },
        onEvent,
      }),
    );
    await manager.replace('cfg-a', 'xapp-a', __fixture.APP_A);

    await client.receive({
      ...__fixture.eventsEnvelope('T-A', ack),
      body: {
        team_id: 'T-A',
        api_app_id: __fixture.APP_A,
        event_id: 'Ev-failed-attachment',
        event: {
          type: 'message',
          subtype: 'bot_message',
          channel: 'C-A',
          ts: '262.3',
          text: '',
          attachments: [{ fallback: 'enqueue this alert' }],
        },
      },
    });

    expect(ack).not.toHaveBeenCalled();
    const emitted = onEvent.mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(emitted.at(-1)).toMatchObject({
      stage: 'outcome',
      outcome: 'failed',
      acknowledged: false,
    });
    expect(JSON.stringify(emitted)).not.toContain(secretText);
  });

  test('a timed-out candidate is disconnected and never replaces the active client', async () => {
    const active = new __fixture.FakeSocketClient();
    const timedOut = new __fixture.FakeSocketClient();
    timedOut.start.mockImplementation(() => new Promise(() => {}));
    const clients = [active, timedOut];
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => clients.shift()!,
        startTimeoutMs: 10,
      }),
    );
    await manager.replace('cfg-a', 'xapp-old', __fixture.APP_A);

    await expect(manager.replace('cfg-a', 'xapp-new', __fixture.APP_A)).rejects.toThrow(
      /timed out/i,
    );

    expect(timedOut.disconnect).toHaveBeenCalledTimes(1);
    expect(active.disconnect).not.toHaveBeenCalled();
    await manager.stopAll();
    expect(active.disconnect).toHaveBeenCalledTimes(1);
  });

  test('a candidate whose start resolves after timeout stays inactive and is disconnected again', async () => {
    const candidate = new __fixture.FakeSocketClient();
    let finishStart!: () => void;
    candidate.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve({});
        }),
    );
    const processEvent = vi.fn(async () => 'classify_enqueued');
    const resolveTeam = vi.fn(async () => ({
      configId: 'cfg-late',
      tenantId: 'tenant-late',
      appId: __fixture.APP_A,
    }));
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        createClient: () => candidate,
        startTimeoutMs: 10,
        processEvent,
        resolveTeam,
      }),
    );

    await expect(manager.replace('cfg-late', 'xapp-late', __fixture.APP_A)).rejects.toThrow(
      /timed out/i,
    );
    expect(candidate.disconnect).toHaveBeenCalledTimes(1);

    const ack = vi.fn(async () => {});
    await candidate.receive(__fixture.eventsEnvelope('T-LATE', ack));
    expect(resolveTeam).not.toHaveBeenCalled();
    expect(processEvent).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();

    finishStart();
    await vi.waitFor(() => expect(candidate.disconnect).toHaveBeenCalledTimes(2));
  });

  test('startAll isolates a failed config and keeps the healthy config active', async () => {
    const failed = new __fixture.FakeSocketClient();
    failed.start.mockRejectedValue(new Error('bad config'));
    const healthy = new __fixture.FakeSocketClient();
    const clients = [failed, healthy];
    const onError = vi.fn();
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        listConnections: async () => [
          { configId: 'cfg-bad', appToken: 'xapp-bad', appId: __fixture.APP_A },
          { configId: 'cfg-good', appToken: 'xapp-good', appId: __fixture.APP_A },
        ],
        createClient: () => clients.shift()!,
        onError,
      }),
    );

    await expect(manager.startAll()).resolves.toBeUndefined();
    expect(failed.disconnect).toHaveBeenCalledTimes(1);
    expect(healthy.start).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await manager.stopAll();
    expect(healthy.disconnect).toHaveBeenCalledTimes(1);
  });

  test('an explicit rotation during deferred startup inventory wins over the stale initial token', async () => {
    let finishInventory!: (
      connections: { configId: string; appToken: string; appId: string }[],
    ) => void;
    const inventory = new Promise<{ configId: string; appToken: string; appId: string }[]>(
      (resolve) => {
        finishInventory = resolve;
      },
    );
    const rotated = new __fixture.FakeSocketClient();
    const createClient = vi.fn((_appToken: string) => rotated);
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(
      __fixture.deps({
        listConnections: () => inventory,
        createClient,
      }),
    );

    const starting = manager.startAll();
    await manager.replace('cfg-race', 'xapp-rotated', __fixture.APP_A);
    finishInventory([{ configId: 'cfg-race', appToken: 'xapp-stale', appId: __fixture.APP_A }]);
    await starting;

    expect(createClient.mock.calls.map(([token]) => token)).toEqual(['xapp-rotated']);
    await manager.stopAll();
    expect(rotated.disconnect).toHaveBeenCalledTimes(1);
  });

  test('an explicit stop during deferred startup inventory prevents a stale initial client', async () => {
    let finishInventory!: (
      connections: { configId: string; appToken: string; appId: string }[],
    ) => void;
    const inventory = new Promise<{ configId: string; appToken: string; appId: string }[]>(
      (resolve) => {
        finishInventory = resolve;
      },
    );
    const createClient = vi.fn((_appToken: string) => new __fixture.FakeSocketClient());
    const makeManager = await __fixture.managerFactory();
    const manager = makeManager(__fixture.deps({ listConnections: () => inventory, createClient }));

    const starting = manager.startAll();
    await manager.stop('cfg-race');
    finishInventory([{ configId: 'cfg-race', appToken: 'xapp-stale', appId: __fixture.APP_A }]);
    await starting;

    expect(createClient).not.toHaveBeenCalled();
  });
});
