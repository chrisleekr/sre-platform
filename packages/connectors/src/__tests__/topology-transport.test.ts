import { afterEach, expect, test, vi } from 'vitest';
import { topologyFetch, topologyReadIssue, TOPOLOGY_RESPONSE_BYTES } from '../topology-transport';

afterEach(() => vi.useRealTimers());

function transport(
  handler: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
) {
  return vi.fn(handler) as ReturnType<typeof vi.fn<typeof handler>> & typeof fetch;
}

test('discovery preserves authentication, redirect and TLS options while bounding the body', async () => {
  const fetchImpl = transport(async () => Response.json({ data: [1] }));
  const options = {
    headers: { Authorization: 'Bearer private-token' },
    redirect: 'error' as const,
    tls: { ca: 'private-ca', rejectUnauthorized: true },
  };
  const response = await topologyFetch(fetchImpl)('https://provider.example/api', options);
  expect(await response.json()).toEqual({ data: [1] });
  expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject(options);
  expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
});

test('the byte boundary is inclusive, regardless of a missing content length', async () => {
  const response = await topologyFetch(
    transport(async () => new Response(new Uint8Array(TOPOLOGY_RESPONSE_BYTES))),
  )('https://provider.example');
  expect((await response.arrayBuffer()).byteLength).toBe(TOPOLOGY_RESPONSE_BYTES);
});

test('oversized declared and streamed bodies are cancelled without parsing provider content', async () => {
  for (const declared of [true, false]) {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TOPOLOGY_RESPONSE_BYTES + 1));
      },
      cancel,
    });
    const fetchImpl = transport(
      async () =>
        new Response(stream, {
          headers: declared ? { 'content-length': String(TOPOLOGY_RESPONSE_BYTES + 1) } : {},
        }),
    );
    await expect(topologyFetch(fetchImpl)('https://provider.example')).rejects.toMatchObject({
      issue: 'limit',
    });
    expect(cancel).toHaveBeenCalledOnce();
  }
});

test('provider failure statuses survive without retaining or reading their response bodies', async () => {
  for (const status of [401, 403, 429, 503]) {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = await topologyFetch(transport(async () => new Response(body, { status })))(
      'https://provider.example',
    );
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('');
    expect(cancel).toHaveBeenCalledOnce();
  }
});

test('a stalled request aborts after the request deadline even if transport ignores the signal', async () => {
  vi.useFakeTimers();
  const fetchImpl = transport(() => new Promise(() => {}));
  const request = topologyFetch(fetchImpl)('https://provider.example');
  const assertion = expect(request).rejects.toMatchObject({ issue: 'unreachable' });
  await vi.advanceTimersByTimeAsync(8000);
  await assertion;
  expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a stalled response stream is cancelled when its request deadline expires', async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const fetchImpl = transport(async () => new Response(new ReadableStream({ cancel })));
  const assertion = expect(
    topologyFetch(fetchImpl)('https://provider.example'),
  ).rejects.toMatchObject({ issue: 'unreachable' });
  await vi.advanceTimersByTimeAsync(8000);
  await assertion;
  expect(cancel).toHaveBeenCalledOnce();
});

test('requests share a collection deadline, and the next discovery gets a fresh budget', async () => {
  vi.useFakeTimers();
  const fetchImpl = transport(async () => Response.json({}));
  const bounded = topologyFetch(fetchImpl);
  await bounded('https://provider.example/first');
  await vi.advanceTimersByTimeAsync(45000);
  await expect(bounded('https://provider.example/next')).rejects.toMatchObject({ issue: 'limit' });
  expect(fetchImpl).toHaveBeenCalledOnce();
  await topologyFetch(fetchImpl)('https://provider.example/fresh');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

test('the remaining collection budget caps a late request', async () => {
  vi.useFakeTimers();
  const bounded = topologyFetch(transport(() => new Promise(() => {})));
  await vi.advanceTimersByTimeAsync(44000);
  const assertion = expect(bounded('https://provider.example')).rejects.toMatchObject({
    issue: 'limit',
  });
  await vi.advanceTimersByTimeAsync(1000);
  await assertion;
});

test('already cancelled Request and init signals do not issue a provider request', async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = transport(async () => Response.json({}));
  const bounded = topologyFetch(fetchImpl);
  await expect(
    bounded(new Request('https://provider.example', { signal: controller.signal })),
  ).rejects.toMatchObject({ issue: 'unreachable' });
  await expect(
    bounded('https://provider.example', { signal: controller.signal }),
  ).rejects.toMatchObject({ issue: 'unreachable' });
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('late transport responses are cancelled after a deadline', async () => {
  vi.useFakeTimers();
  let resolve!: (response: Response) => void;
  const bounded = topologyFetch(
    transport(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    ),
  );
  const assertion = expect(bounded('https://provider.example')).rejects.toMatchObject({
    issue: 'unreachable',
  });
  await vi.advanceTimersByTimeAsync(8000);
  await assertion;
  const cancel = vi.fn();
  resolve(new Response(new ReadableStream({ cancel })));
  await vi.advanceTimersByTimeAsync(0);
  expect(cancel).toHaveBeenCalledOnce();
});

test('ordinary provider failures are not relabelled as discovery limits', () => {
  expect(topologyReadIssue(new Error('private provider content'))).toBeUndefined();
});
