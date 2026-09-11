import { makeSmeeManager, type SmeeManager } from './smee';
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

export type GitHubSmeeManager = SmeeManager;

export function makeGitHubSmeeManager(options: {
  port: number;
  log: Logger;
  createClient?: (options: RelayOptions) => RelayClient;
}): GitHubSmeeManager {
  return makeSmeeManager({ ...options, connectorType: 'github' });
}
