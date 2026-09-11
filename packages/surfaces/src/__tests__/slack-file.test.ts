import { describe, expect, test, vi } from 'vitest';
import { makeSlackFileFetcher, SLACK_FILE_MAX_BYTES, type FileFetchLike } from '../slack-file';

/** A single-chunk ReadableStream over `bytes`, mirroring a real fetch Response body. */
const streamOf = (bytes: ArrayBuffer): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });

const okResponse = (bytes: ArrayBuffer, contentType = 'image/png', contentLength?: number) => ({
  ok: true,
  status: 200,
  headers: {
    get: (name: string): string | null => {
      const n = name.toLowerCase();
      if (n === 'content-type') return contentType;
      if (n === 'content-length') return contentLength === undefined ? null : String(contentLength);
      return null;
    },
  },
  body: streamOf(bytes),
});

describe('makeSlackFileFetcher', () => {
  const getToken = async (): Promise<string | null> => 'xoxb-test-token';

  test('rejects a non-Slack host (SSRF guard) without fetching', async () => {
    const fetch = vi.fn<FileFetchLike>();
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    await expect(fetcher.fetch('t1', 'https://evil.example.com/a.png')).rejects.toThrow();
    // 169.254.169.254 style metadata endpoint is also rejected.
    await expect(fetcher.fetch('t1', 'http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('accepts a files.slack.com host and sends the bot token as a Bearer header, fail-closed on redirect', async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const fetch = vi.fn<FileFetchLike>(async () => okResponse(bytes, 'image/png', 3));
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    const out = await fetcher.fetch('t1', 'https://files.slack.com/files-pri/T1-F1/screenshot.png');
    expect(out.contentType).toBe('image/png');
    expect(out.bytes.byteLength).toBe(3);
    const [, init] = fetch.mock.calls[0]!;
    expect(init?.headers?.authorization).toBe('Bearer xoxb-test-token');
    // A redirect off the pinned host must never be followed (SSRF): the fetch is issued redirect:'error'.
    expect(init?.redirect).toBe('error');
  });

  test('a redirect (redirect:error → fetch rejects) surfaces as a failure, never leaving the pinned host', async () => {
    // With redirect:'error', a 3xx off the Slack host makes the real fetch throw; model that here.
    const fetch = vi.fn<FileFetchLike>(async () => {
      throw new TypeError('unexpected redirect');
    });
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    await expect(fetcher.fetch('t1', 'https://files.slack.com/redir.png')).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]?.redirect).toBe('error');
  });

  test('accepts any *.slack.com subdomain host', async () => {
    const bytes = new Uint8Array([9]).buffer;
    const fetch = vi.fn<FileFetchLike>(async () => okResponse(bytes, 'image/jpeg', 1));
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    await expect(fetcher.fetch('t1', 'https://files-edge.slack.com/x.jpg')).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('enforces the size cap via Content-Length before reading the body', async () => {
    const fetch = vi.fn<FileFetchLike>(async () =>
      okResponse(new ArrayBuffer(1), 'image/png', SLACK_FILE_MAX_BYTES + 1),
    );
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    await expect(fetcher.fetch('t1', 'https://files.slack.com/big.png')).rejects.toThrow(
      /too large/i,
    );
  });

  test('enforces the size cap on the actual body when Content-Length is absent', async () => {
    const oversize = new ArrayBuffer(SLACK_FILE_MAX_BYTES + 1);
    const fetch = vi.fn<FileFetchLike>(async () => okResponse(oversize, 'image/png'));
    const fetcher = makeSlackFileFetcher({ fetch, getToken });
    await expect(fetcher.fetch('t1', 'https://files.slack.com/big.png')).rejects.toThrow(
      /too large/i,
    );
  });

  test('throws when the tenant has no bot token (nothing to authorize the fetch)', async () => {
    const fetch = vi.fn<FileFetchLike>();
    const fetcher = makeSlackFileFetcher({ fetch, getToken: async () => null });
    await expect(fetcher.fetch('t1', 'https://files.slack.com/a.png')).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
