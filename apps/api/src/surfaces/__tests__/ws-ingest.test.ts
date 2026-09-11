import { describe, expect, test } from 'vitest';
import type { HubMessage } from '@sre/hub';
import type { WsAcceptedFrame, WsErrorFrame } from '@sre/contracts';
import { handleIngestFrame } from '../ws-ingest';
import { IngestRefusedError, type IncidentSession } from '../session';
import { makeTokenBucket } from '../rate-limit';

// A session whose ingest either records the content or throws whatever the test hands it.
function fakeSession(onIngest?: () => never): { session: IncidentSession; ingested: string[] } {
  const ingested: string[] = [];
  const session: IncidentSession = {
    adapter: {
      surface: 'dashboard',
      project: () => {},
      ingest: async ({ content }) => {
        onIngest?.();
        ingested.push(content);
        return { id: 'm1', content } as unknown as HubMessage;
      },
    },
    close: async () => {},
  };
  return { session, ingested };
}

function ctxFor(session: IncidentSession, capacity = 5) {
  const frames: WsErrorFrame[] = [];
  const accepted: WsAcceptedFrame[] = [];
  const bucket = makeTokenBucket({ capacity, refillPerSec: 0, now: () => 0 });
  return {
    ctx: {
      session,
      bucket,
      send: (frame: WsErrorFrame | WsAcceptedFrame) => {
        if (frame.type === 'error') frames.push(frame);
        else accepted.push(frame);
      },
    },
    frames,
    accepted,
  };
}

describe('ws ingest frame handling', () => {
  test('a good frame ingests and emits no error frame', async () => {
    const { session, ingested } = fakeSession();
    const { ctx, frames } = ctxFor(session);

    await handleIngestFrame(ctx, JSON.stringify({ content: 'ack, on it' }));

    expect(ingested).toEqual(['ack, on it']);
    expect(frames).toHaveLength(0);
  });

  test('a keyed frame is acknowledged with the committed message id', async () => {
    const { session } = fakeSession();
    const { ctx, accepted } = ctxFor(session);
    const clientMessageId = '019c7c42-0d6e-7dce-a0dc-1d7d9069d78d';

    await handleIngestFrame(ctx, JSON.stringify({ content: 'check the pool', clientMessageId }));

    expect(accepted).toEqual([{ type: 'accepted', clientMessageId, messageId: 'm1' }]);
  });

  test('a refused post answers with a discriminated error frame carrying its code', async () => {
    const { session, ingested } = fakeSession(() => {
      throw new IngestRefusedError('content_too_long', 'message exceeds the content limit');
    });
    const { ctx, frames } = ctxFor(session);

    // The socket must survive the refusal: handleIngestFrame resolves rather than rejecting, so the Bun
    // handler has no unhandled rejection and never closes the connection over one bad post.
    await expect(
      handleIngestFrame(ctx, JSON.stringify({ content: 'hi' })),
    ).resolves.toBeUndefined();

    expect(ingested).toHaveLength(0);
    expect(frames).toEqual([
      { type: 'error', code: 'content_too_long', message: 'message exceeds the content limit' },
    ]);
    // The frame is distinguishable from a HubMessage, which carries no `type`.
    expect(frames[0]!.type).toBe('error');
  });

  test('an infrastructure failure emits a generic error frame and does not reject', async () => {
    const { session } = fakeSession(() => {
      throw new Error('postgres is down');
    });
    const { ctx, frames } = ctxFor(session);

    await expect(
      handleIngestFrame(ctx, JSON.stringify({ content: 'hi' })),
    ).resolves.toBeUndefined();

    expect(frames[0]!.code).toBe('internal_error');
    // The internal cause never crosses the wire.
    expect(frames[0]!.message).not.toContain('postgres');
  });

  test('a rate-limited frame is refused with feedback instead of a silent drop', async () => {
    const { session, ingested } = fakeSession();
    const { ctx, frames } = ctxFor(session, 1);

    await handleIngestFrame(ctx, JSON.stringify({ content: 'first' }));
    await handleIngestFrame(ctx, JSON.stringify({ content: 'second' }));

    // Budget of one: the second frame never reaches ingest, and the client is told why.
    expect(ingested).toEqual(['first']);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.code).toBe('rate_limited');
  });

  test('an oversized raw frame is refused BEFORE JSON.parse (CWE-770)', async () => {
    const { session, ingested } = fakeSession();
    const { ctx, frames } = ctxFor(session);

    // Not valid JSON, so reaching JSON.parse would be observable as a silent no-op rather than a refusal.
    // The bound must trip on the raw frame length: Bun accepts frames up to 16MB, and an authed socket
    // must not be able to buy that much parse allocation per message.
    await handleIngestFrame(ctx, 'x'.repeat(200_000));

    expect(ingested).toHaveLength(0);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.code).toBe('content_too_long');
  });

  test('an empty frame is a no-op (still costs a token, never reaches ingest)', async () => {
    const { session, ingested } = fakeSession();
    const { ctx, frames } = ctxFor(session);

    await handleIngestFrame(ctx, JSON.stringify({ content: '   ' }));

    expect(ingested).toHaveLength(0);
    expect(frames).toHaveLength(0);
  });
});
