function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

/**
 * Returns the administrative database URL used only for DDL and migrations.
 */
export const adminUrl = (): string => required('DATABASE_URL');

/**
 * Returns the RLS-scoped application database URL, falling back to the administrative URL.
 */
export const appUrl = (): string => process.env.APP_DATABASE_URL ?? required('DATABASE_URL');

/**
 * Returns the base64-encoded secret-store master key.
 */
export const masterKey = (): string => required('SECRETS_MASTER_KEY');

/**
 * Returns the configured embeddings service URL.
 */
export const embeddingsUrl = (): string => process.env.EMBEDDINGS_URL ?? 'http://localhost:8080';

/**
 * Returns the configured embedding vector dimension.
 */
export const embeddingsDim = (): number => Number(process.env.EMBEDDINGS_DIM ?? '1024');
