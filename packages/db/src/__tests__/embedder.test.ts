import { afterEach, expect, test, vi } from 'vitest';
import { EMBED_DIM, makeEmbedder } from '../embedder';

afterEach(() => vi.restoreAllMocks());

test('makeEmbedder rejects a dim that is not EMBED_DIM', () => {
  expect(EMBED_DIM).toBe(1024);
  expect(() => makeEmbedder('http://localhost:8080', 512)).toThrow(/EMBED_DIM/);
  expect(() => makeEmbedder('http://localhost:8080', EMBED_DIM)).not.toThrow();
});

test('makeEmbedder defaults url + dim from env config (EMBED_DIM single source of truth)', () => {
  // With no args it reads EMBEDDINGS_URL/EMBEDDINGS_DIM via the env helpers; dim defaults to EMBED_DIM.
  const emb = makeEmbedder();
  expect(emb.dim).toBe(EMBED_DIM);
});

test('makeEmbedder fails fast when EMBEDDINGS_DIM config drifts from EMBED_DIM', () => {
  const prev = process.env.EMBEDDINGS_DIM;
  process.env.EMBEDDINGS_DIM = '512';
  try {
    expect(() => makeEmbedder()).toThrow(/EMBED_DIM/);
  } finally {
    if (prev === undefined) delete process.env.EMBEDDINGS_DIM;
    else process.env.EMBEDDINGS_DIM = prev;
  }
});

test('embed posts inputs and returns vectors', async () => {
  const fake = [[0.1, 0.2, 0.3]];
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(fake), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  const emb = makeEmbedder('http://localhost:8080', 1024);
  const out = await emb.embed(['hello']);
  expect(out).toEqual(fake);
  expect(emb.dim).toBe(1024);
  expect(spy).toHaveBeenCalledWith(
    'http://localhost:8080/embed',
    expect.objectContaining({ method: 'POST' }),
  );
});

test('embed throws on a non-ok response', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('err', { status: 500 }));
  const emb = makeEmbedder('http://localhost:8080', 1024);
  await expect(emb.embed(['x'])).rejects.toThrow(/500/);
});
