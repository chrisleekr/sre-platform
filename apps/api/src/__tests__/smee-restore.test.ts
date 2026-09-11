import { describe, expect, test, vi } from 'vitest';
import { connectorEventCredentialKey, type Db, type SecretStore } from '@sre/db';
import {
  alertmanagerEventCredential,
  githubCredentialBundle,
  gitLabCredentialBundle,
  gitLabSmeeUrl,
} from '@sre/connectors';
import { restoreAlertmanagerSmeeRelays, restoreSmeeRelays } from '../smee-restore';

function fakeDb(
  rows: unknown[],
  updates: Array<Record<string, unknown>> = [],
  rejectUpdate: (values: Record<string, unknown>) => boolean = () => false,
): Db {
  const tx = {
    rollback: () => {},
    execute: async () => {},
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          if (rejectUpdate(values)) throw new Error('health update failed');
          updates.push(values);
        },
      }),
    }),
  };
  return {
    select: () => ({ from: () => ({ where: async () => rows }) }),
    transaction: async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as Db;
}

function fakeSecrets(values: Record<string, string>): SecretStore {
  return {
    get: vi.fn(async (tenantId, key) => values[`${tenantId}:${key}`] ?? null),
    put: vi.fn(async (tenantId, key, value) => {
      values[`${tenantId}:${key}`] = value;
    }),
    has: vi.fn(async () => false),
    delete: vi.fn(async () => {}),
  };
}

describe('restoreSmeeRelays', () => {
  test('restores only configured Alertmanager relays and isolates one row failure', async () => {
    const values = {
      [`tenant-a:${connectorEventCredentialKey('prom-a')}`]: alertmanagerEventCredential(
        'alertmanager-event-token-a',
        'https://smee.io/prom-a',
      ),
      [`tenant-b:${connectorEventCredentialKey('prom-b')}`]: alertmanagerEventCredential(
        'alertmanager-event-token-b',
        'https://smee.io/prom-b',
      ),
    };
    const replace = vi.fn(async (tenantId: string) => {
      if (tenantId === 'tenant-a') throw new Error('offline');
    });
    const log = { info: vi.fn(), error: vi.fn() };
    const healthUpdates: Array<Record<string, unknown>> = [];

    await restoreAlertmanagerSmeeRelays({
      db: fakeDb(
        [
          {
            tenantId: 'tenant-a',
            connectorId: 'prom-a',
            webhookKey: 'key-a',
            enabled: true,
            settings: { eventTransport: 'smee' },
          },
          {
            tenantId: 'tenant-direct',
            connectorId: 'prom-direct',
            webhookKey: 'key-direct',
            enabled: true,
            settings: { eventTransport: 'direct' },
          },
          {
            tenantId: 'tenant-disabled',
            connectorId: 'prom-disabled',
            webhookKey: 'key-disabled',
            enabled: false,
            settings: { eventTransport: 'smee' },
          },
          {
            tenantId: 'tenant-b',
            connectorId: 'prom-b',
            webhookKey: 'key-b',
            enabled: true,
            settings: { eventTransport: 'smee' },
          },
          {
            tenantId: 'tenant-missing',
            connectorId: 'prom-missing',
            webhookKey: 'key-missing',
            enabled: true,
            settings: { eventTransport: 'smee' },
          },
        ],
        healthUpdates,
      ),
      secrets: fakeSecrets(values),
      manager: { replace },
      log,
    });

    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('tenant-b', 'prom-b', 'https://smee.io/prom-b', 'key-b');
    expect(log.error).toHaveBeenCalledWith(
      'Alertmanager Smee relay restore failed',
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(healthUpdates.map((update) => update.eventFailureCategory)).toEqual([
      'relay_unreachable',
      null,
      'relay_unreachable',
    ]);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('https://smee.io');
  });

  test('restores saved relays, skips non-Smee rows, and isolates one tenant failure', async () => {
    const rows = [
      {
        tenantId: 'tenant-a',
        connectorId: 'source-a',
        webhookKey: 'key-a',
        settings: { eventTransport: 'smee' },
      },
      {
        tenantId: 'tenant-skip',
        connectorId: 'source-skip',
        webhookKey: 'key-skip',
        settings: { eventTransport: 'direct' },
      },
      {
        tenantId: 'tenant-b',
        connectorId: 'source-b',
        webhookKey: 'key-b',
        settings: { eventTransport: 'smee' },
      },
    ];
    const secrets = fakeSecrets({
      'tenant-a:connector:source-a': githubCredentialBundle(
        'private-a',
        'webhook-secret-a',
        'https://smee.io/a',
      ),
      'tenant-b:connector:source-b': githubCredentialBundle(
        'private-b',
        'webhook-secret-b',
        'https://smee.io/b',
      ),
    });
    const replace = vi.fn(async (tenantId: string) => {
      if (tenantId === 'tenant-a') throw new Error('offline');
    });
    const log = { info: vi.fn(), error: vi.fn() };

    await restoreSmeeRelays({
      provider: 'github',
      db: fakeDb(rows),
      secrets,
      manager: { replace },
      log,
    });

    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace).toHaveBeenCalledWith('tenant-b', 'source-b', 'https://smee.io/b', 'key-b');
    expect(log.error).toHaveBeenCalledWith(
      'GitHub Smee relay restore failed',
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
  });

  test('does not report a connected relay as failed when its health write fails', async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const healthUpdates: Array<Record<string, unknown>> = [];
    const replace = vi.fn(async () => {});

    await restoreAlertmanagerSmeeRelays({
      db: fakeDb(
        [
          {
            tenantId: 'tenant-a',
            connectorId: 'prom-a',
            webhookKey: 'key-a',
            enabled: true,
            settings: { eventTransport: 'smee' },
          },
        ],
        healthUpdates,
        (values) => values.eventFailureCategory === null,
      ),
      secrets: fakeSecrets({
        [`tenant-a:${connectorEventCredentialKey('prom-a')}`]: alertmanagerEventCredential(
          'alertmanager-event-token-a',
          'https://smee.io/prom-a',
        ),
      }),
      manager: { replace },
      log,
    });

    expect(replace).toHaveBeenCalledTimes(1);
    expect(healthUpdates).toEqual([]);
    expect(log.error).toHaveBeenCalledWith(
      'Alertmanager Smee relay health update failed',
      expect.objectContaining({ tenantId: 'tenant-a' }),
    );
    expect(log.error).not.toHaveBeenCalledWith(
      'Alertmanager Smee relay restore failed',
      expect.anything(),
    );
  });

  test('migrates one legacy GitLab channel into the encrypted connector credential', async () => {
    const values = {
      'tenant-a:connector:source-a': gitLabCredentialBundle('glpat-read', {
        webhookSigningToken: `whsec_${Buffer.alloc(32, 4).toString('base64')}`,
      }),
    };
    const secrets = fakeSecrets(values);
    const replace = vi.fn(async () => {});

    await restoreSmeeRelays({
      provider: 'gitlab',
      db: fakeDb([
        {
          tenantId: 'tenant-a',
          connectorId: 'source-a',
          webhookKey: 'key-a',
          settings: { eventTransport: 'smee' },
        },
      ]),
      secrets,
      manager: { replace },
      legacySource: 'https://smee.io/legacy',
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(gitLabSmeeUrl(values['tenant-a:connector:source-a'])).toBe('https://smee.io/legacy');
    expect(replace).toHaveBeenCalledWith('tenant-a', 'source-a', 'https://smee.io/legacy', 'key-a');
  });

  test('never applies one legacy channel across multiple tenant rows', async () => {
    const secrets = fakeSecrets({
      'tenant-a:connector:source-a': gitLabCredentialBundle('glpat-a'),
      'tenant-b:connector:source-b': gitLabCredentialBundle('glpat-b'),
    });
    const replace = vi.fn(async () => {});

    await restoreSmeeRelays({
      provider: 'gitlab',
      db: fakeDb([
        {
          tenantId: 'tenant-a',
          connectorId: 'source-a',
          webhookKey: 'key-a',
          settings: { eventTransport: 'smee' },
        },
        {
          tenantId: 'tenant-b',
          connectorId: 'source-b',
          webhookKey: 'key-b',
          settings: { eventTransport: 'smee' },
        },
      ]),
      secrets,
      manager: { replace },
      legacySource: 'https://smee.io/ambiguous',
      log: { info: vi.fn(), error: vi.fn() },
    });

    expect(replace).not.toHaveBeenCalled();
    expect(secrets.put).not.toHaveBeenCalled();
  });
});
