import { SocketModeClient } from '@slack/socket-mode';
export { slackAppIdFromToken } from '../slack-connection';

const DEFAULT_START_TIMEOUT_MS = 15_000;

export interface SlackTeamRoute {
  configId: string;
  tenantId: string;
  appId: string;
  botUserId?: string;
  botId?: string;
}

export interface SlackSocketEnvelope {
  type: string;
  body: Record<string, unknown>;
  ack: (response: Record<string, unknown>) => Promise<void>;
}

export interface SlackSocketClient {
  readonly connected?: boolean;
  on(event: string, listener: (...args: unknown[]) => void | Promise<void>): this;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackSocketManagerDeps {
  listConnections(): Promise<{ configId: string; appToken: string; appId: string }[]>;
  resolveTeam(teamId: string, appId: string): Promise<SlackTeamRoute | undefined>;
  processEvent(route: SlackTeamRoute, body: Record<string, unknown>): Promise<string | void>;
  processInteraction(route: SlackTeamRoute, body: Record<string, unknown>): Promise<string | void>;
  recordDrop?: (
    envelopeType: string,
    body: Record<string, unknown>,
    outcome: string,
    route?: SlackTeamRoute,
  ) => Promise<void>;
  createClient?: (appToken: string) => SlackSocketClient;
  startTimeoutMs?: number;
  onEvent?: (event: SlackSocketEvent) => void;
  onError?: (error: unknown) => void;
}

export interface SlackSocketEvent {
  stage: 'receive' | 'route' | 'drop' | 'outcome' | 'lifecycle';
  envelopeType: string;
  teamId?: string;
  appId?: string;
  eventId?: string;
  eventType?: string;
  eventSubtype?: string;
  channel?: string;
  configId?: string;
  tenantId?: string;
  action?: 'start' | 'replace' | 'stop';
  reason?: 'missing_team' | 'missing_app' | 'app_mismatch' | 'unknown_team';
  outcome?: string;
  acknowledged?: boolean;
}

export interface SlackSocketManager {
  startAll(): Promise<void>;
  replace(configId: string, appToken: string, appId: string): Promise<void>;
  stop(configId: string): Promise<void>;
  stopAll(): Promise<void>;
  status(configId: string): SlackSocketRuntimeStatus;
}

export interface SlackSocketRuntimeStatus {
  state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
  connectedAt: string | null;
  updatedAt: string;
}

function teamIdFrom(envelope: SlackSocketEnvelope): string | undefined {
  if (envelope.type === 'events_api') {
    return typeof envelope.body.team_id === 'string' ? envelope.body.team_id : undefined;
  }
  if (envelope.type === 'interactive') {
    const team = envelope.body.team;
    if (team && typeof team === 'object' && 'id' in team && typeof team.id === 'string') {
      return team.id;
    }
  }
  return undefined;
}

function eventMetadata(
  envelope: SlackSocketEnvelope,
): Pick<SlackSocketEvent, 'eventId' | 'eventType' | 'eventSubtype' | 'channel'> {
  const eventId = typeof envelope.body.event_id === 'string' ? envelope.body.event_id : undefined;
  const rawEvent = envelope.body.event;
  const event =
    typeof rawEvent === 'object' && rawEvent !== null
      ? (rawEvent as Record<string, unknown>)
      : undefined;
  const eventType =
    typeof event?.type === 'string'
      ? event.type
      : typeof envelope.body.type === 'string'
        ? envelope.body.type
        : undefined;
  return {
    eventId,
    eventType,
    eventSubtype: typeof event?.subtype === 'string' ? event.subtype : undefined,
    channel: typeof event?.channel === 'string' ? event.channel : undefined,
  };
}

export function makeSlackSocketManager(deps: SlackSocketManagerDeps): SlackSocketManager {
  type ManagedClient = { client: SlackSocketClient; deactivate: () => void };
  const clients = new Map<string, ManagedClient>();
  const runtime = new Map<string, SlackSocketRuntimeStatus>();
  const operations = new Map<string, Promise<void>>();
  const explicitlyMutated = new Set<string>();
  const createClient =
    deps.createClient ??
    ((appToken: string) =>
      new SocketModeClient({ appToken, autoReconnectEnabled: true }) as SlackSocketClient);
  const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;

  const emit = (event: SlackSocketEvent): void => {
    try {
      deps.onEvent?.(event);
    } catch {
      // Observability must not change Slack's acknowledgement or lifecycle contract.
    }
  };

  const serialize = <T>(configId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = operations.get(configId) ?? Promise.resolve();
    const run = previous.then(operation);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    operations.set(configId, settled);
    void settled.then(() => {
      if (operations.get(configId) === settled) operations.delete(configId);
    });
    return run;
  };

  const receive = async (receivingAppId: string, envelope: SlackSocketEnvelope): Promise<void> => {
    const envelopeType = envelope.type;
    const teamId = teamIdFrom(envelope);
    const envelopeAppId =
      typeof envelope.body.api_app_id === 'string' ? envelope.body.api_app_id : undefined;
    const metadata = {
      envelopeType,
      teamId,
      appId: envelopeAppId,
      ...eventMetadata(envelope),
    };
    let route: SlackTeamRoute | undefined;
    emit({ stage: 'receive', ...metadata });

    try {
      const reason = !teamId
        ? 'missing_team'
        : !envelopeAppId
          ? 'missing_app'
          : envelopeAppId !== receivingAppId
            ? 'app_mismatch'
            : undefined;
      if (reason) {
        emit({ stage: 'drop', ...metadata, reason });
        await deps.recordDrop?.(envelopeType, envelope.body, reason);
        await envelope.ack({});
        emit({ stage: 'outcome', ...metadata, outcome: 'dropped', acknowledged: true });
        return;
      }

      route = await deps.resolveTeam(teamId!, envelopeAppId!);
      if (!route || route.appId !== receivingAppId) {
        const routeReason = route ? 'app_mismatch' : 'unknown_team';
        emit({
          stage: 'drop',
          ...metadata,
          reason: routeReason,
        });
        await deps.recordDrop?.(envelopeType, envelope.body, routeReason);
        await envelope.ack({});
        emit({ stage: 'outcome', ...metadata, outcome: 'dropped', acknowledged: true });
        return;
      }

      emit({
        stage: 'route',
        ...metadata,
        configId: route.configId,
        tenantId: route.tenantId,
      });

      let outcome: string | void;
      if (envelope.type === 'events_api') {
        outcome = await deps.processEvent(route, envelope.body);
      } else if (envelope.type === 'interactive') {
        outcome = await deps.processInteraction(route, envelope.body);
      } else {
        outcome = 'dropped_unsupported_envelope';
        await deps.recordDrop?.(envelopeType, envelope.body, outcome, route);
      }
      await envelope.ack({});
      emit({
        stage: 'outcome',
        ...metadata,
        configId: route.configId,
        tenantId: route.tenantId,
        outcome: outcome ?? 'processed',
        acknowledged: true,
      });
    } catch (error) {
      emit({
        stage: 'outcome',
        ...metadata,
        configId: route?.configId,
        tenantId: route?.tenantId,
        outcome: 'failed',
        acknowledged: false,
      });
      deps.onError?.(error);
    }
  };

  const startCandidate = async (
    configId: string,
    appToken: string,
    appId: string,
  ): Promise<ManagedClient> => {
    const candidate = createClient(appToken);
    runtime.set(configId, {
      state: 'connecting',
      connectedAt: null,
      updatedAt: new Date().toISOString(),
    });
    let active = true;
    const deactivate = (): void => {
      active = false;
    };
    const setRuntime = (state: SlackSocketRuntimeStatus['state']): void => {
      const previous = runtime.get(configId);
      const now = new Date().toISOString();
      runtime.set(configId, {
        state,
        connectedAt: state === 'connected' ? (previous?.connectedAt ?? now) : null,
        updatedAt: now,
      });
    };
    candidate.on('connected', () => setRuntime('connected'));
    candidate.on('reconnecting', () => setRuntime('reconnecting'));
    candidate.on('disconnected', () => setRuntime('disconnected'));
    candidate.on('slack_event', (...args) => {
      const envelope = args[0] as SlackSocketEnvelope;
      if (!active) return;
      return receive(appId, envelope);
    });
    let start: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      start = candidate.start();
      // A timeout disconnects the SDK, which rejects start before cleanup can await it. Attach the
      // rejection handler now so Bun never observes that SDK rejection as unhandled.
      void start.catch(() => {});
      await Promise.race([
        start,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Slack Socket Mode start timed out')),
            startTimeoutMs,
          );
        }),
      ]);
      setRuntime('connected');
      return { client: candidate, deactivate };
    } catch (error) {
      deactivate();
      await candidate.disconnect().catch(() => {});
      if (start) {
        void start.then(
          () => candidate.disconnect().catch(() => {}),
          () => {},
        );
      }
      setRuntime('disconnected');
      emit({
        stage: 'lifecycle',
        envelopeType: 'socket',
        appId,
        configId,
        action: 'start',
        outcome: 'failed',
      });
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const replaceActive = async (
    configId: string,
    appToken: string,
    appId: string,
  ): Promise<void> => {
    const current = clients.get(configId);
    const candidate = await startCandidate(configId, appToken, appId);
    try {
      await current?.client.disconnect();
    } catch (error) {
      candidate.deactivate();
      await candidate.client.disconnect().catch(() => {});
      throw error;
    }
    current?.deactivate();
    clients.set(configId, candidate);
    const now = new Date().toISOString();
    runtime.set(configId, { state: 'connected', connectedAt: now, updatedAt: now });
  };

  const startInitial = (configId: string, appToken: string, appId: string): Promise<void> =>
    serialize(configId, async () => {
      if (explicitlyMutated.has(configId)) return;
      await replaceActive(configId, appToken, appId);
    });

  const manager: SlackSocketManager = {
    async startAll() {
      const connections = await deps.listConnections();
      await Promise.all(
        connections.map(async (connection) => {
          try {
            await startInitial(connection.configId, connection.appToken, connection.appId);
          } catch (error) {
            deps.onError?.(error);
          }
        }),
      );
    },

    replace(configId, appToken, appId) {
      explicitlyMutated.add(configId);
      return serialize(configId, () => replaceActive(configId, appToken, appId));
    },

    stop(configId) {
      explicitlyMutated.add(configId);
      return serialize(configId, async () => {
        const client = clients.get(configId);
        if (!client) return;
        await client.client.disconnect();
        client.deactivate();
        clients.delete(configId);
        runtime.set(configId, {
          state: 'disconnected',
          connectedAt: null,
          updatedAt: new Date().toISOString(),
        });
      });
    },

    async stopAll() {
      const configIds = new Set([...clients.keys(), ...operations.keys()]);
      await Promise.allSettled([...configIds].map((configId) => manager.stop(configId)));
    },

    status(configId) {
      const current = clients.get(configId);
      const saved = runtime.get(configId);
      if (current?.client.connected === true && saved?.state !== 'connected') {
        const now = new Date().toISOString();
        return { state: 'connected', connectedAt: now, updatedAt: now };
      }
      if (current?.client.connected === false && saved?.state === 'connected') {
        return { state: 'reconnecting', connectedAt: null, updatedAt: new Date().toISOString() };
      }
      return (
        saved ?? {
          state: current ? 'connected' : 'disconnected',
          connectedAt: null,
          updatedAt: new Date().toISOString(),
        }
      );
    },
  };

  return manager;
}
