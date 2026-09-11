import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { HubMessage } from '@sre/hub';
import type { IncidentSession, SessionDeps } from '../session';

const mocks = vi.hoisted(() => ({
  openIncidentSession: vi.fn(),
}));

// Vitest runs on Node; the lifecycle helper itself is runtime-agnostic, so stub the Bun-only route
// adapter while importing its module.
vi.mock('hono/bun', () => ({ upgradeWebSocket: vi.fn(() => vi.fn()) }));

vi.mock('../session', async (importOriginal) => {
  const original = await importOriginal<typeof import('../session')>();
  return { ...original, openIncidentSession: mocks.openIncidentSession };
});

import { incidentWebSocketEvents } from '../ws';

function deferredSession(): {
  promise: Promise<IncidentSession | null>;
  resolve: (session: IncidentSession | null) => void;
} {
  let resolve!: (session: IncidentSession | null) => void;
  return {
    promise: new Promise((done) => {
      resolve = done;
    }),
    resolve,
  };
}

function fakeSession() {
  const ingest = vi.fn(async ({ content }: { content: string }) => {
    return { id: 'message-1', content } as unknown as HubMessage;
  });
  return {
    session: { adapter: { surface: 'dashboard', project: vi.fn(), ingest }, close: vi.fn() },
    ingest,
  } as const;
}

function fakeSocket() {
  const sent: string[] = [];
  return {
    socket: {
      readyState: 1,
      send: (value: string) => sent.push(value),
      close: vi.fn(),
    },
    sent,
  } as const;
}

beforeEach(() => {
  mocks.openIncidentSession.mockReset();
});

describe('dashboard WebSocket lifecycle', () => {
  test('holds the first frame until the async session opens', async () => {
    const deferred = deferredSession();
    const { session, ingest } = fakeSession();
    mocks.openIncidentSession.mockReturnValue(deferred.promise);
    const events = incidentWebSocketEvents(
      {} as SessionDeps,
      '11111111-1111-4111-8111-111111111111',
      'ticket-1',
    );
    const { socket, sent } = fakeSocket();
    const clientMessageId = '019c7c42-0d6e-7dce-a0dc-1d7d9069d78d';

    const opening = Promise.resolve(events.onOpen!(undefined as never, socket as never));
    const first = Promise.resolve(
      events.onMessage!(
        { data: JSON.stringify({ content: 'check the pool', clientMessageId }) } as never,
        socket as never,
      ),
    );
    await Promise.resolve();
    expect(ingest).not.toHaveBeenCalled();

    deferred.resolve(session);
    await Promise.all([opening, first]);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith({ content: 'check the pool', clientMessageId });
    expect(sent.map((frame) => JSON.parse(frame))).toContainEqual({
      type: 'accepted',
      clientMessageId,
      messageId: 'message-1',
    });
  });

  test('closes instead of responding repeatedly when another frame arrives before authorization', async () => {
    const deferred = deferredSession();
    const { session, ingest } = fakeSession();
    mocks.openIncidentSession.mockReturnValue(deferred.promise);
    const events = incidentWebSocketEvents(
      {} as SessionDeps,
      '11111111-1111-4111-8111-111111111111',
      'ticket-1',
    );
    const { socket, sent } = fakeSocket();

    const opening = Promise.resolve(events.onOpen!(undefined as never, socket as never));
    const first = Promise.resolve(
      events.onMessage!(
        { data: JSON.stringify({ content: 'first while opening' }) } as never,
        socket as never,
      ),
    );
    await events.onMessage!(
      { data: JSON.stringify({ content: 'second while opening' }) } as never,
      socket as never,
    );
    await events.onMessage!(
      { data: JSON.stringify({ content: 'third while opening' }) } as never,
      socket as never,
    );

    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledWith(
      1008,
      'only one frame is allowed while the session opens',
    );
    expect(sent).toEqual([]);
    deferred.resolve(session);
    await Promise.all([opening, first]);
    expect(session.close).toHaveBeenCalledTimes(1);
    expect(ingest).not.toHaveBeenCalled();
  });

  test('settles a frame without ingesting when session authorization fails', async () => {
    const deferred = deferredSession();
    mocks.openIncidentSession.mockReturnValue(deferred.promise);
    const events = incidentWebSocketEvents(
      {} as SessionDeps,
      '11111111-1111-4111-8111-111111111111',
      'ticket-1',
    );
    const { socket } = fakeSocket();

    const opening = Promise.resolve(events.onOpen!(undefined as never, socket as never));
    const message = Promise.resolve(
      events.onMessage!(
        { data: JSON.stringify({ content: 'must not persist' }) } as never,
        socket as never,
      ),
    );
    deferred.resolve(null);

    await expect(Promise.all([opening, message])).resolves.toBeDefined();
  });

  test('closes a session that finishes opening after the socket has disconnected', async () => {
    const deferred = deferredSession();
    const { session } = fakeSession();
    mocks.openIncidentSession.mockReturnValue(deferred.promise);
    const events = incidentWebSocketEvents(
      {} as SessionDeps,
      '11111111-1111-4111-8111-111111111111',
      'ticket-1',
    );
    const { socket } = fakeSocket();

    const opening = Promise.resolve(events.onOpen!(undefined as never, socket as never));
    await events.onClose!(undefined as never, socket as never);
    deferred.resolve(session);
    await opening;

    expect(session.close).toHaveBeenCalledTimes(1);
  });
});
