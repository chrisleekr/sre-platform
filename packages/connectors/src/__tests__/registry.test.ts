import { afterEach, describe, expect, test, vi } from 'vitest';
import { CONNECTOR_TYPES, connectorCapabilities, isConnectorType } from '../catalog';
import { makeFakeConnector } from '../fake';
import {
  ConnectorRegistry,
  createDataSourceConnector,
  defineConnector,
  type ConnectorConfig,
} from '../registry';
import { defaultRegistry, developmentRegistryOptions } from '../registry-default';

const cfg: ConnectorConfig = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Test Datadog',
  tenantId: 't1',
  type: 'datadog',
  settings: {},
  getCredential: async () => 'key',
};

afterEach(() => vi.unstubAllGlobals());

describe('ConnectorRegistry', () => {
  test('freezes definitions and clones caller-owned capabilities', () => {
    const capabilities = { ...connectorCapabilities('datadog') };
    const definition = defineConnector({
      type: 'datadog',
      capabilities,
      create: makeFakeConnector,
    });

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.capabilities)).toBe(true);
    capabilities.availability = 'incomplete';
    expect(definition.capabilities.availability).toBe('ready');
  });

  test('registers and creates a connector', () => {
    const r = new ConnectorRegistry();
    r.register(
      defineConnector({
        type: 'datadog',
        capabilities: connectorCapabilities('datadog'),
        create: makeFakeConnector,
      }),
    );
    expect(r.has('datadog')).toBe(true);
    expect(r.create(cfg).type).toBe('datadog');
  });

  test('throws for an unregistered type', () => {
    expect(() => new ConnectorRegistry().create(cfg)).toThrow(/no connector registered/);
  });

  test('rejects duplicate provider definitions instead of silently replacing one', () => {
    const definition = defineConnector({
      type: 'datadog',
      capabilities: connectorCapabilities('datadog'),
      create: makeFakeConnector,
    });
    const registry = new ConnectorRegistry([definition]);
    expect(() => registry.register(definition)).toThrow(/already registered/);
  });

  test('rejects a factory whose runtime capabilities drift from its definition', () => {
    const registry = new ConnectorRegistry([
      defineConnector({
        type: 'datadog',
        capabilities: connectorCapabilities('datadog'),
        create: (config) => ({
          ...makeFakeConnector(config),
          capabilities: connectorCapabilities('github'),
        }),
      }),
    ]);

    expect(() => registry.create(cfg)).toThrow(/inconsistent capabilities/);
  });

  test('rejects a factory that returns another connector type', () => {
    const registry = new ConnectorRegistry([
      defineConnector({
        type: 'datadog',
        capabilities: connectorCapabilities('datadog'),
        create: (config) => ({ ...makeFakeConnector(config), type: 'github' }),
      }),
    ]);

    expect(() => registry.create(cfg)).toThrow(
      'connector factory for datadog returned type: github',
    );
  });

  test.each([
    { identity: { id: '00000000-0000-4000-8000-000000000099' }, field: 'id' },
    { identity: { name: 'Changed identity' }, field: 'name' },
  ])('rejects a factory that changes the configured $field', ({ identity }) => {
    const registry = new ConnectorRegistry([
      defineConnector({
        type: 'datadog',
        capabilities: connectorCapabilities('datadog'),
        create: (config) => ({ ...makeFakeConnector(config), ...identity }),
      }),
    ]);

    expect(() => registry.create(cfg)).toThrow(
      'connector factory for datadog changed data-source identity',
    );
  });

  test('composes unsupported ports once for a minimal provider implementation', async () => {
    const metadata = {
      type: 'datadog',
      capabilities: connectorCapabilities('datadog'),
    } as const;
    const connector = createDataSourceConnector(cfg, metadata, {
      tools: () => [],
      probe: async () => ({
        status: 'healthy',
        reachable: true,
        authorized: true,
        warnings: [],
      }),
    });

    expect(connector).toMatchObject({ id: cfg.id, name: cfg.name, type: 'datadog' });
    expect(connector.tools()).toEqual([]);
    await expect(connector.snapshot()).rejects.toThrow(/does not support snapshot polling/);
    await expect(
      connector.fetchTriageContext({ service: 'checkout', windowMinutes: 30 }),
    ).rejects.toThrow(/does not support triage context/);
  });

  test('rejects configuration metadata for another connector type', () => {
    expect(() =>
      createDataSourceConnector(
        cfg,
        { type: 'github', capabilities: connectorCapabilities('github') },
        {
          probe: async () => ({
            status: 'healthy',
            reachable: true,
            authorized: true,
            warnings: [],
          }),
        },
      ),
    ).toThrow('connector factory for github cannot create configuration type: datadog');
  });

  test('fake connector normalizes a snapshot', async () => {
    const c = makeFakeConnector(cfg);
    const snaps = await c.snapshot();
    expect(snaps[0]!.source).toBe('datadog');
  });

  test('the eleven mandated connector types are present and guarded', () => {
    expect(CONNECTOR_TYPES).toHaveLength(11);
    expect(isConnectorType('gitlab')).toBe(true);
    expect(isConnectorType('argocd')).toBe(true);
    expect(isConnectorType('statuscake')).toBe(true);
    expect(isConnectorType('grafana')).toBe(true);
    expect(isConnectorType('networkprobe')).toBe(true);
    expect(isConnectorType('nope')).toBe(false);
  });

  test('every ready connector has identity, declared capabilities, and investigator tools', () => {
    const registry = defaultRegistry();
    for (const type of CONNECTOR_TYPES) {
      const capabilities = connectorCapabilities(type);
      if (capabilities.availability === 'incomplete') {
        expect(capabilities.investigation).toBe('none');
        continue;
      }

      expect(registry.has(type), `${type} must have a registered adapter`).toBe(true);
      const connector = registry.create({
        ...cfg,
        name: `Test ${type}`,
        type,
      });
      expect(connector).toMatchObject({
        id: cfg.id,
        name: `Test ${type}`,
        type,
        capabilities,
      });
      expect(connector.tools().length, `${type} must expose investigator tools`).toBeGreaterThan(0);
      expect(capabilities.instances).toBe(type === 'networkprobe' ? 'singleton' : 'multiple');
      expect(capabilities.configuration).toBe(type === 'networkprobe' ? 'builtin' : 'tenant');
    }
  });

  test('derives exact loopback origins only for the supervised development composition', () => {
    expect(
      developmentRegistryOptions({
        NODE_ENV: 'development',
        SRE_DEV_CONNECTOR_LOOPBACK: 'true',
        DEV_PROMETHEUS_LOCAL_PORT: '19090',
        DEV_GRAFANA_LOCAL_PORT: '13000',
      }),
    ).toEqual({
      prometheusLoopbackOrigin: 'http://127.0.0.1:19090',
      grafanaLoopbackOrigin: 'http://127.0.0.1:13000',
    });
    for (const env of [
      { NODE_ENV: 'production', SRE_DEV_CONNECTOR_LOOPBACK: 'true' },
      { NODE_ENV: 'development' },
      {
        NODE_ENV: 'development',
        SRE_DEV_CONNECTOR_LOOPBACK: 'true',
        DEV_OBSERVABILITY_TUNNELS: 'false',
      },
    ]) {
      expect(developmentRegistryOptions(env)).toEqual({});
    }
  });

  test('default registry rejects loopback and admits only each configured tunnel origin', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        return url.port === '9090'
          ? Response.json({ status: 'success', data: { result: [] } })
          : Response.json({ id: 1, name: 'Main Org.' });
      }),
    );
    const prometheusConfig: ConnectorConfig = {
      ...cfg,
      type: 'prometheus',
      name: 'Local Prometheus',
      settings: { baseUrl: 'http://127.0.0.1:9090' },
      getCredential: async () => JSON.stringify({ type: 'none' }),
    };
    const grafanaConfig: ConnectorConfig = {
      ...cfg,
      type: 'grafana',
      name: 'Local Grafana',
      settings: { baseUrl: 'http://127.0.0.1:3000' },
      getCredential: async () => 'service-token',
    };

    await expect(defaultRegistry().create(prometheusConfig).probe()).resolves.toMatchObject({
      status: 'unhealthy',
      reachable: false,
    });
    const localRegistry = defaultRegistry({
      prometheusLoopbackOrigin: 'http://127.0.0.1:9090',
      grafanaLoopbackOrigin: 'http://127.0.0.1:3000',
    });
    await expect(localRegistry.create(prometheusConfig).probe()).resolves.toMatchObject({
      status: 'healthy',
      reachable: true,
    });
    await expect(localRegistry.create(grafanaConfig).probe()).resolves.toMatchObject({
      status: 'healthy',
      reachable: true,
    });
  });
});
