import { and, eq, sql } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Db } from './client';
import { withTenant, type Executor } from './rls';
import { tenantSecrets } from './schema';

const KEY_VERSION = 1;
const INFO = Buffer.from('sre-secretstore-v1');

/** Per-tenant AES-256 subkey derived from the master key. */
function subkey(masterKey: Buffer, tenantId: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(tenantId), INFO, 32));
}

export interface SecretStore {
  put: (tenantId: string, name: string, plaintext: string, exec?: Executor) => Promise<void>;
  get: (tenantId: string, name: string, exec?: Executor) => Promise<string | null>;
  /** Presence check without decrypting — a corrupt-GCM record still answers true. */
  has: (tenantId: string, name: string, exec?: Executor) => Promise<boolean>;
  delete: (tenantId: string, name: string, exec?: Executor) => Promise<void>;
}

/**
 * Builds the tenant-scoped encrypted secret store.
 *
 * @param db - Database connection used for the operation.
 * @param masterKeyB64 - Base64-encoded master key used for envelope encryption.
 */
export function makeSecretStore(db: Db, masterKeyB64: string): SecretStore {
  const masterKey = Buffer.from(masterKeyB64, 'base64');
  if (masterKey.length !== 32) {
    throw new Error('SECRETS_MASTER_KEY must decode to 32 bytes (base64-encoded AES-256 key)');
  }

  async function put(
    tenantId: string,
    name: string,
    plaintext: string,
    exec: Executor = db,
  ): Promise<void> {
    const key = subkey(masterKey, tenantId);
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintext, 'utf8')),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    await withTenant(exec, tenantId, async (tx) => {
      await tx
        .insert(tenantSecrets)
        .values({ tenantId, name, ciphertext, nonce, authTag, keyVersion: KEY_VERSION })
        .onConflictDoUpdate({
          target: [tenantSecrets.tenantId, tenantSecrets.name],
          set: { ciphertext, nonce, authTag, keyVersion: KEY_VERSION, updatedAt: sql`now()` },
        });
    });
  }

  async function get(tenantId: string, name: string, exec: Executor = db): Promise<string | null> {
    return withTenant(exec, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.name, name)));
      const row = rows[0];
      if (!row) return null;
      const key = subkey(masterKey, tenantId);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce));
      decipher.setAuthTag(Buffer.from(row.authTag));
      const pt = Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]);
      return pt.toString('utf8');
    });
  }

  async function has(tenantId: string, name: string, exec: Executor = db): Promise<boolean> {
    return withTenant(exec, tenantId, async (tx) => {
      const rows = await tx
        .select({ one: sql`1` })
        .from(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.name, name)))
        .limit(1);
      return rows.length > 0;
    });
  }

  async function del(tenantId: string, name: string, exec: Executor = db): Promise<void> {
    await withTenant(exec, tenantId, (tx) =>
      tx
        .delete(tenantSecrets)
        .where(and(eq(tenantSecrets.tenantId, tenantId), eq(tenantSecrets.name, name))),
    );
  }

  return { put, get, has, delete: del };
}
