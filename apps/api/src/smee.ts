import SmeeClient from 'smee-client';
import type { Logger } from './logger';

interface RelayClient {
  start(): Promise<unknown>;
  stop(): Promise<void>;
}

interface RelayOptions {
  source: string;
  target: string;
  logger: Pick<Console, 'info' | 'error'>;
  maxConnectionTimeout: number;
}

interface ActiveRelay {
  source: string;
  target: string;
  client: RelayClient;
}

export interface SmeeManager {
  replace(tenantId: string, connectorId: string, source: string, webhookKey: string): Promise<void>;
  stop(connectorId: string): Promise<void>;
  stopAll(): Promise<void>;
}

type SmeeConnectorType = 'github' | 'gitlab' | 'alertmanager';

function smeeSource(input: string, connectorType: SmeeConnectorType): string {
  const url = new URL(input);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'smee.io' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(`${connectorType} Smee source must be an https://smee.io channel URL`);
  return url.toString();
}

export function makeSmeeManager(options: {
  connectorType: SmeeConnectorType;
  port: number;
  log: Logger;
  createClient?: (options: RelayOptions) => RelayClient;
}): SmeeManager {
  const active = new Map<string, ActiveRelay>();
  const createClient =
    options.createClient ?? ((config: RelayOptions) => new SmeeClient(config) as RelayClient);
  const provider =
    options.connectorType === 'github'
      ? 'GitHub'
      : options.connectorType === 'gitlab'
        ? 'GitLab'
        : 'Alertmanager';

  const stop = async (connectorId: string): Promise<void> => {
    const current = active.get(connectorId);
    if (!current) return;
    active.delete(connectorId);
    await current.client.stop();
    options.log.info(`${provider} Smee relay stopped`, { connectorId });
  };

  return {
    async replace(tenantId, connectorId, input, webhookKey) {
      const source = smeeSource(input, options.connectorType);
      const target = `http://127.0.0.1:${options.port}/webhooks/${options.connectorType}/${encodeURIComponent(webhookKey)}`;
      const current = active.get(connectorId);
      if (current?.source === source && current.target === target) return;

      const client = createClient({
        source,
        target,
        maxConnectionTimeout: 8_000,
        logger: {
          info: () => undefined,
          error: () =>
            options.log.error(`${provider} Smee relay connection error`, {
              tenantId,
              failureCategory: 'unreachable',
            }),
        },
      });
      try {
        await client.start();
      } catch (error) {
        await client.stop().catch(() => undefined);
        options.log.error(`${provider} Smee relay failed to start`, {
          tenantId,
          failureCategory: 'unreachable',
          errorType: error instanceof Error ? error.name : typeof error,
        });
        throw error;
      }

      active.set(connectorId, { source, target, client });
      await current?.client.stop().catch(() => undefined);
      options.log.info(`${provider} Smee relay started`, { tenantId, connectorId });
    },
    stop,
    async stopAll() {
      await Promise.all([...active.keys()].map(stop));
    },
  };
}
