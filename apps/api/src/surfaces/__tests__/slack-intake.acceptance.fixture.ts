import type { SlackSocketClient, SlackSocketEnvelope } from '../slack-socket';

export class FakeSocketClient implements SlackSocketClient {
  connected = false;
  private listener?: (envelope: SlackSocketEnvelope) => void | Promise<void>;

  on(event: string, listener: (...args: unknown[]) => void | Promise<void>): this {
    if (event === 'slack_event') {
      this.listener = listener as (envelope: SlackSocketEnvelope) => void | Promise<void>;
    }
    return this;
  }

  async start(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async receive(envelope: SlackSocketEnvelope): Promise<void> {
    if (!this.listener) throw new Error('Socket listener is not registered');
    await this.listener(envelope);
  }
}

export function createEventsApiEnvelope(suffix: string) {
  return (
    eventId: string,
    event: Record<string, unknown>,
    ack: SlackSocketEnvelope['ack'] = async () => undefined,
  ): SlackSocketEnvelope => ({
    type: 'events_api',
    body: {
      type: 'event_callback',
      team_id: `T_${suffix}`,
      api_app_id: `A_${suffix}`,
      event_id: eventId,
      event,
    },
    ack,
  });
}
