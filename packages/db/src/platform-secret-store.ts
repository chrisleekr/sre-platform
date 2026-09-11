import { eq, sql } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Executor } from './rls';
import { platformSecrets } from './schema';

const KEY_VERSION = 1;
const INFO = Buffer.from('sre-platform-secretstore-v1');
const SALT = Buffer.from('platform-control-plane');

export interface PlatformSecretStore {
  put(name: string, plaintext: string): Promise<void>;
  get(name: string): Promise<string | null>;
  has(name: string): Promise<boolean>;
  delete(name: string): Promise<void>;
}

/**
 * AES-256-GCM store for platform-global credentials. Only the admin connection can reach its table.
 *
 * @param db - Database connection used for the operation.
 * @param masterKeyB64 - Base64-encoded master key used for envelope encryption.
 */
export function makePlatformSecretStore(db: Executor, masterKeyB64: string): PlatformSecretStore {
  const masterKey = Buffer.from(masterKeyB64, 'base64');
  if (masterKey.length !== 32) {
    throw new Error('SECRETS_MASTER_KEY must decode to 32 bytes (base64-encoded AES-256 key)');
  }
  const key = Buffer.from(hkdfSync('sha256', masterKey, SALT, INFO, 32));

  async function put(name: string, plaintext: string): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    await db
      .insert(platformSecrets)
      .values({ name, ciphertext, nonce, authTag, keyVersion: KEY_VERSION })
      .onConflictDoUpdate({
        target: platformSecrets.name,
        set: { ciphertext, nonce, authTag, keyVersion: KEY_VERSION, updatedAt: sql`now()` },
      });
  }

  async function get(name: string): Promise<string | null> {
    const rows = await db
      .select()
      .from(platformSecrets)
      .where(eq(platformSecrets.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce));
    decipher.setAuthTag(Buffer.from(row.authTag));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext)),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  }

  async function has(name: string): Promise<boolean> {
    const rows = await db
      .select({ one: sql`1` })
      .from(platformSecrets)
      .where(eq(platformSecrets.name, name))
      .limit(1);
    return rows.length > 0;
  }

  async function del(name: string): Promise<void> {
    await db.delete(platformSecrets).where(eq(platformSecrets.name, name));
  }

  return { put, get, has, delete: del };
}
