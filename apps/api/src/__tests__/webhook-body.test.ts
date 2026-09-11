import { describe, expect, test } from 'vitest';
import { readBoundedWebhookBody, WebhookPayloadTooLargeError } from '../webhook-body';

function streamedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  let index = 0;
  return new Request('http://localhost/webhook', {
    method: 'POST',
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks[index++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(encoder.encode(chunk));
      },
    }),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

describe('readBoundedWebhookBody', () => {
  test('reads a chunked body at the byte limit', async () => {
    await expect(readBoundedWebhookBody(streamedRequest(['ab', 'cd']), 4)).resolves.toBe('abcd');
  });

  test('stops a chunked body before buffering bytes beyond the limit', async () => {
    await expect(readBoundedWebhookBody(streamedRequest(['abcd', 'e']), 4)).rejects.toBeInstanceOf(
      WebhookPayloadTooLargeError,
    );
  });
});
