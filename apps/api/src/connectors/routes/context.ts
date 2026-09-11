import type {
  ConnectorRoutesDeps,
  GitHubSettings,
  GitLabSettings,
  PrometheusSettings,
} from '../helpers';

export type RelayStatus = 'connected' | 'stopped' | 'failed' | undefined;

export interface ConnectorRouteContext {
  deps: ConnectorRoutesDeps;
  serializeMutation<T>(tenantId: string, type: string, operation: () => Promise<T>): Promise<T>;
  mutationPending(tenantId: string, operationId: string): boolean;
  reconcileGitHubSmee(
    tenantId: string,
    connectorId: string,
    settings: Pick<GitHubSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<RelayStatus>;
  reconcileGitLabSmee(
    tenantId: string,
    connectorId: string,
    settings: Pick<GitLabSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<RelayStatus>;
  reconcileAlertmanagerSmee(
    tenantId: string,
    connectorId: string,
    settings: Pick<PrometheusSettings, 'eventTransport'>,
    credential: string | null,
    webhookKey: string,
  ): Promise<RelayStatus>;
  legacyConnectorId(tenantId: string, type: string): Promise<string | null | 'ambiguous'>;
}
