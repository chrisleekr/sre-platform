// Live-infra test (mirrors packages/db/src/__tests__/incident-repo.test.ts): seeds tenants, enabled
// connector_configs, and secrets as the superuser admin role, then resolves under app_user so
// FORCE ROW LEVEL SECURITY actually binds. Proves bidirectional tenant isolation,
// same-transaction credential capture, the missing-secret failure, and that a valid-but-
// unregistered connector type degrades to absent without discarding its registered siblings.
import {
  ConnectorRegistry,
  datadogConnectorDefinition,
  defineConnector,
  makeFakeConnector,
  networkProbeConnectorDefinition,
  statusCakeConnectorDefinition,
  type ConnectorConfig,
} from '@sre/connectors';
import {
  connectorConfigs,
  connectorCredentialKey,
  makeDb,
  makeSecretStore,
  tenantSecrets,
  tenants,
  type DbHandle,
  type SecretStore,
} from '@sre/db';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { makeDbConnectorProvider } from '../connector-provider';

const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://sre:sre@localhost:5432/sre_platform';
const APP_URL =
  process.env.APP_DATABASE_URL ?? 'postgres://app_user:app@localhost:5432/sre_platform';
const KEY = Buffer.alloc(32, 7).toString('base64'); // deterministic 32-byte test key

let admin: DbHandle;
let app: DbHandle;
let store: SecretStore;
let registry: ConnectorRegistry;
let lastConfig: ConnectorConfig | undefined;
const configsByType = new Map<string, ConnectorConfig>();
const configsById = new Map<string, ConnectorConfig>();
let tenantA: string;
let tenantB: string;
let tenantNoSecret: string;
let tenantUnregistered: string;
let tenantCorrupt: string;
let tenantMultiple: string;
const connectorIds = new Map<string, string>();

beforeAll(async () => {
  admin = makeDb(ADMIN_URL);
  app = makeDb(APP_URL);
  store = makeSecretStore(app.db, KEY);
  // Datadog and StatusCake are registered; Kubernetes has no factory.
  registry = new ConnectorRegistry();
  registry.register(
    defineConnector({
      ...datadogConnectorDefinition,
      create: (config) => {
        lastConfig = config;
        configsByType.set(config.type, config);
        configsById.set(config.id, config);
        return makeFakeConnector(config);
      },
    }),
  );
  registry.register(
    defineConnector({
      ...statusCakeConnectorDefinition,
      create: (config) => {
        configsByType.set(config.type, config);
        configsById.set(config.id, config);
        return makeFakeConnector(config);
      },
    }),
  );
  tenantA = randomUUID();
  tenantB = randomUUID();
  tenantNoSecret = randomUUID();
  tenantUnregistered = randomUUID();
  tenantCorrupt = randomUUID();
  tenantMultiple = randomUUID();
  const ids = [tenantA, tenantB, tenantNoSecret, tenantUnregistered, tenantCorrupt, tenantMultiple];
  // Admin (sre) is a superuser and bypasses RLS, so it seeds the RLS-forced connector_configs
  // directly; tenants is control-plane (no RLS).
  await admin.db.insert(tenants).values(ids.map((id) => ({ id, name: id.slice(0, 8) })));
  const connector = (tenantId: string, type: 'datadog' | 'kubernetes' | 'statuscake') => {
    const id = randomUUID();
    connectorIds.set(`${tenantId}:${type}`, id);
    return { id, tenantId, name: `${type}-${id.slice(0, 4)}`, type, settings: {}, enabled: true };
  };
  await admin.db
    .insert(connectorConfigs)
    .values([
      connector(tenantA, 'datadog'),
      connector(tenantB, 'datadog'),
      connector(tenantNoSecret, 'datadog'),
      connector(tenantUnregistered, 'datadog'),
      connector(tenantUnregistered, 'kubernetes'),
      connector(tenantCorrupt, 'datadog'),
      connector(tenantCorrupt, 'statuscake'),
    ]);
  const multiPrimaryId = randomUUID();
  const multiSecondaryId = randomUUID();
  connectorIds.set(`${tenantMultiple}:datadog:primary`, multiPrimaryId);
  connectorIds.set(`${tenantMultiple}:datadog:secondary`, multiSecondaryId);
  await admin.db.insert(connectorConfigs).values([
    {
      id: multiPrimaryId,
      tenantId: tenantMultiple,
      name: 'Primary Datadog',
      type: 'datadog',
      settings: { site: 'datadoghq.com' },
      enabled: true,
    },
    {
      id: multiSecondaryId,
      tenantId: tenantMultiple,
      name: 'Secondary Datadog',
      type: 'datadog',
      settings: { site: 'datadoghq.eu' },
      enabled: true,
    },
  ]);
  await store.put(
    tenantA,
    connectorCredentialKey(connectorIds.get(`${tenantA}:datadog`)!),
    'A-secret',
  );
  await store.put(
    tenantB,
    connectorCredentialKey(connectorIds.get(`${tenantB}:datadog`)!),
    'B-secret',
  );
  await store.put(
    tenantUnregistered,
    connectorCredentialKey(connectorIds.get(`${tenantUnregistered}:datadog`)!),
    'U-secret',
  );
  await store.put(
    tenantCorrupt,
    connectorCredentialKey(connectorIds.get(`${tenantCorrupt}:datadog`)!),
    'corrupt-me',
  );
  await store.put(
    tenantCorrupt,
    connectorCredentialKey(connectorIds.get(`${tenantCorrupt}:statuscake`)!),
    'healthy-secret',
  );
  await store.put(tenantMultiple, connectorCredentialKey(multiPrimaryId), 'primary-secret');
  await store.put(tenantMultiple, connectorCredentialKey(multiSecondaryId), 'secondary-secret');
  await admin.db
    .update(tenantSecrets)
    .set({ authTag: Buffer.alloc(16, 0) })
    .where(
      and(
        eq(tenantSecrets.tenantId, tenantCorrupt),
        eq(
          tenantSecrets.name,
          connectorCredentialKey(connectorIds.get(`${tenantCorrupt}:datadog`)!),
        ),
      ),
    );
  // tenantNoSecret intentionally has an enabled config but no stored credential.
}, 30_000);

afterAll(async () => {
  if (admin) {
    const tids = sql`tenant_id in (${tenantA}, ${tenantB}, ${tenantNoSecret}, ${tenantUnregistered}, ${tenantCorrupt}, ${tenantMultiple})`;
    await admin.db.delete(connectorConfigs).where(tids);
    await admin.db.delete(tenantSecrets).where(tids);
    await admin.db
      .delete(tenants)
      .where(
        sql`id in (${tenantA}, ${tenantB}, ${tenantNoSecret}, ${tenantUnregistered}, ${tenantCorrupt}, ${tenantMultiple})`,
      );
    await admin.close();
  }
  if (app) await app.close();
});

describe('makeDbConnectorProvider + RLS', () => {
  test('resolves the enabled connectors for a tenant under app_user RLS', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    const connectors = await provider(tenantA)();
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.type).toBe('datadog');
    expect(connectors[0]!.generation).toMatchObject({
      id: expect.any(String),
      lifecycleVersion: 0,
    });
  });

  test('wires getCredential to the secret captured with the connector row', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    await provider(tenantA)();
    expect(lastConfig).toBeDefined();
    expect(await lastConfig!.getCredential()).toBe('A-secret');
  });

  test('isolates connectors bidirectionally: each tenant sees only its own (RLS)', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    const a = await provider(tenantA)();
    const credA = await lastConfig!.getCredential();
    const b = await provider(tenantB)();
    const credB = await lastConfig!.getCredential();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(credA).toBe('A-secret');
    expect(credB).toBe('B-secret');
  });

  test('rejects getCredential when the config has no stored secret', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    await provider(tenantNoSecret)();
    expect(lastConfig).toBeDefined();
    expect(lastConfig!.credentialStatus).toBe('unavailable');
    await expect(lastConfig!.getCredential()).rejects.toThrow(/no credential stored/);
  });

  test('skips a valid-but-unregistered connector type, keeping registered siblings', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    const connectors = await provider(tenantUnregistered)();
    expect(connectors).toHaveLength(1);
    expect(connectors[0]!.type).toBe('datadog');
  });

  test('isolates a corrupt credential to its connector while preserving healthy siblings', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    const connectors = await provider(tenantCorrupt)();
    expect(connectors.map((connector) => connector.type).sort()).toEqual(['datadog', 'statuscake']);
    expect(configsByType.get('datadog')!.credentialStatus).toBe('unavailable');
    expect(configsByType.get('statuscake')!.credentialStatus).toBe('available');
    await expect(configsByType.get('datadog')!.getCredential()).rejects.toThrow(
      /credential unavailable/,
    );
    await expect(configsByType.get('statuscake')!.getCredential()).resolves.toBe('healthy-secret');
  });

  test('resolves multiple instances of one type with independent identity and credentials', async () => {
    const provider = makeDbConnectorProvider({ db: app.db, registry, secrets: store });
    const connectors = await provider(tenantMultiple)();

    expect(
      connectors
        .map(({ id, name, type }) => ({ id, name, type }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      {
        id: connectorIds.get(`${tenantMultiple}:datadog:primary`),
        name: 'Primary Datadog',
        type: 'datadog',
      },
      {
        id: connectorIds.get(`${tenantMultiple}:datadog:secondary`),
        name: 'Secondary Datadog',
        type: 'datadog',
      },
    ]);
    const primary = connectors.find((connector) => connector.name === 'Primary Datadog')!;
    const secondary = connectors.find((connector) => connector.name === 'Secondary Datadog')!;
    await expect(configsById.get(primary.id)!.getCredential()).resolves.toBe('primary-secret');
    await expect(configsById.get(secondary.id)!.getCredential()).resolves.toBe('secondary-secret');
  });

  test('injects exactly one built-in Network Probe and does not duplicate a legacy row', async () => {
    const registryWithProbe = new ConnectorRegistry();
    registryWithProbe.register(
      defineConnector({ ...datadogConnectorDefinition, create: makeFakeConnector }),
    );
    registryWithProbe.register(
      defineConnector({ ...networkProbeConnectorDefinition, create: makeFakeConnector }),
    );
    const provider = makeDbConnectorProvider({
      db: app.db,
      registry: registryWithProbe,
      secrets: store,
    });

    const builtIn = await provider(tenantA)();
    expect(
      builtIn
        .filter((connector) => connector.type === 'networkprobe')
        .map((connector) => ({
          id: connector.id,
          name: connector.name,
          investigation: connector.capabilities?.investigation,
        })),
    ).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Network probe',
        investigation: 'tools',
      },
    ]);

    const legacyId = randomUUID();
    try {
      await admin.db.insert(connectorConfigs).values({
        id: legacyId,
        tenantId: tenantA,
        name: 'Legacy network probe',
        type: 'networkprobe',
        settings: {},
        enabled: true,
      });
      const withLegacy = await provider(tenantA)();
      expect(withLegacy.filter((connector) => connector.type === 'networkprobe')).toHaveLength(1);
      expect(withLegacy.find((connector) => connector.type === 'networkprobe')).toMatchObject({
        id: legacyId,
        name: 'Legacy network probe',
      });
    } finally {
      await admin.db.delete(connectorConfigs).where(eq(connectorConfigs.id, legacyId));
    }
  });
});
