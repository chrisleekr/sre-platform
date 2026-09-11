// Local embeddings. Talks to the self-hosted TEI server from docker-compose.
// The model and dimension are global; vectors must stay comparable across the corpus.
import { embeddingsDim, embeddingsUrl } from './env';

// Single source of truth for the embedding dimension. The knowledge_chunks `embedding` column is
// vector(EMBED_DIM), so a model whose output dimension differs would write vectors the schema
// cannot store or rank. makeEmbedder rejects a mismatch at construction rather than at query time.
export const EMBED_DIM = 1024;

export interface Embedder {
  readonly dim: number;
  embed: (texts: string[]) => Promise<number[][]>;
}

// Default url + dim from the env config (single wiring point) so the configured EMBEDDINGS_DIM is
// validated against EMBED_DIM at construction — config and the schema's vector(EMBED_DIM) column
// cannot drift. Callers pass no args in production.
/**
 * Builds the configured embeddings client.
 *
 * @param url - Value supplied for url.
 * @param dim - Value supplied for dim.
 */
export function makeEmbedder(
  url: string = embeddingsUrl(),
  dim: number = embeddingsDim(),
): Embedder {
  if (dim !== EMBED_DIM) {
    throw new Error(
      `embedder dim ${dim} must equal EMBED_DIM (${EMBED_DIM}); check EMBEDDINGS_DIM`,
    );
  }
  async function embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${url}/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs: texts }),
    });
    if (!res.ok) {
      throw new Error(`embeddings request failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as number[][];
  }
  return { dim, embed };
}
