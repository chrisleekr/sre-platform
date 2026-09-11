import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { eq } from 'drizzle-orm';
import { makeDb } from '../client';
import { platformSecrets } from '../schema';
import { makePlatformSecretStore } from '../platform-secret-store';

const db = makeDb(process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform');
const key = Buffer.alloc(32, 11).toString('base64');

beforeAll(async () => {
  await db.sql`select 1`;
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.db.delete(platformSecrets);
});

describe('PlatformSecretStore', () => {
  test('round-trips and replaces one write-only platform credential', async () => {
    const store = makePlatformSecretStore(db.db, key);
    expect(await store.has('llm:credential')).toBe(false);
    await store.put('llm:credential', 'first');
    expect(await store.get('llm:credential')).toBe('first');
    await store.put('llm:credential', 'second');
    expect(await store.get('llm:credential')).toBe('second');
    expect(await store.has('llm:credential')).toBe(true);
  });

  test('ciphertext is not plaintext and tampering fails authentication', async () => {
    const store = makePlatformSecretStore(db.db, key);
    await store.put('llm:credential', 'do-not-store-plaintext');
    const [row] = await db.db
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.name, 'llm:credential'));
    expect(row?.ciphertext.toString('utf8')).not.toContain('do-not-store-plaintext');
    await db.sql`update platform_secrets set ciphertext = decode('00', 'hex') where name = 'llm:credential'`;
    await expect(store.get('llm:credential')).rejects.toThrow();
  });

  test('delete removes the credential', async () => {
    const store = makePlatformSecretStore(db.db, key);
    await store.put('llm:credential', 'secret');
    await store.delete('llm:credential');
    expect(await store.get('llm:credential')).toBeNull();
  });
});
