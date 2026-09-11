import { expect, vi } from 'vitest';

interface SlackRoute {
  configId: string;
  tenantId: string;
  appId: string;
}

interface SlackEnvelope {
  type: string;
  body: Record<string, unknown>;
  ack: (response?: Record<string, unknown>) => Promise<void>;
}

type EnvelopeListener = (envelope: SlackEnvelope) => void | Promise<void>;

export class FakeSocketClient {
  connected = false;
  readonly start = vi.fn(async () => {
    this.connected = true;
    return {};
  });
  readonly disconnect = vi.fn(async () => {
    this.connected = false;
  });
  private listener?: EnvelopeListener;

  on(event: string, listener: EnvelopeListener): this {
    if (event === 'slack_event') this.listener = listener;
    return this;
  }

  async receive(envelope: SlackEnvelope): Promise<void> {
    expect(this.listener).toBeTypeOf('function');
    await this.listener?.(envelope);
  }
}

interface ManagerDeps {
  listConnections: () => Promise<{ configId: string; appToken: string; appId: string }[]>;
  resolveTeam: (teamId: string, appId: string) => Promise<SlackRoute | undefined>;
  processEvent: (route: SlackRoute, body: Record<string, unknown>) => Promise<unknown>;
  processInteraction: (route: SlackRoute, body: Record<string, unknown>) => Promise<unknown>;
  recordDrop?: (
    envelopeType: string,
    body: Record<string, unknown>,
    outcome: string,
    route?: SlackRoute,
  ) => Promise<void>;
  createClient: (appToken: string) => FakeSocketClient;
  startTimeoutMs?: number;
  onEvent?: (event: Record<string, unknown>) => void;
  onError?: (error: unknown) => void;
}

interface SlackSocketManager {
  startAll(): Promise<void>;
  replace(configId: string, appToken: string, appId: string): Promise<void>;
  stop(configId: string): Promise<void>;
  stopAll(): Promise<void>;
  status(configId: string): { state: string };
}

export function createFixture() {
  async function managerFactory(): Promise<(deps: ManagerDeps) => SlackSocketManager> {
    const socket = (await import('../slack-socket')) as unknown as {
      makeSlackSocketManager?: (deps: ManagerDeps) => SlackSocketManager;
    };
    expect(socket.makeSlackSocketManager).toBeTypeOf('function');
    return socket.makeSlackSocketManager!;
  }

  const APP_A = 'AAPP262';

  const APP_B = 'AOTHER262';

  const eventsEnvelope = (
    teamId: string,
    ack = vi.fn(async () => {}),
    appId = APP_A,
  ): SlackEnvelope => ({
    type: 'events_api',
    body: {
      team_id: teamId,
      api_app_id: appId,
      event_id: 'Ev-262',
      event: { type: 'message', channel: 'C262', ts: '262.1', text: 'alert' },
    },
    ack,
  });

  const interactiveEnvelope = (
    teamId: string,
    ack = vi.fn(async () => {}),
    appId = APP_A,
  ): SlackEnvelope => ({
    type: 'interactive',
    body: {
      type: 'block_actions',
      api_app_id: appId,
      team: { id: teamId },
      actions: [{ action_id: 'approve' }],
    },
    ack,
  });

  function deps(overrides: Partial<ManagerDeps> = {}): ManagerDeps {
    return {
      listConnections: async () => [],
      resolveTeam: async () => undefined,
      processEvent: async () => {},
      processInteraction: async () => {},
      createClient: () => new FakeSocketClient(),
      ...overrides,
    };
  }

  return {
    FakeSocketClient,
    managerFactory,
    APP_A,
    APP_B,
    eventsEnvelope,
    interactiveEnvelope,
    deps,
  };
}

export type TestFixture = ReturnType<typeof createFixture>;
