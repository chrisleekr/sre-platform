import type { ConnectorType } from '@sre/connectors';
import type { Tx } from '@sre/db';
import type {
  ConnectorRoutesDeps,
  GitLabSettings,
  GrafanaSettings,
  LegacyGitHubCredential,
  PrometheusSettings,
} from '../../helpers';

export interface CurrentConnector {
  name: string;
  settings: unknown;
  webhookKey: string | null;
}

export interface SavePersistenceInput {
  tx: Tx;
  deps: ConnectorRoutesDeps;
  tenantId: string;
  connectorId: string;
  type: ConnectorType;
  creating: boolean;
  requestedName: string | undefined;
  enabled: boolean;
  body: Record<string, unknown>;
  credential: string | undefined;
  submittedWebhookSecret: string | undefined;
  submittedEventToken: string | undefined;
  submittedWebhookSigningToken: string | null;
  submittedLegacy: LegacyGitHubCredential | null;
  parsedGitLabSettings: GitLabSettings | null;
  parsedPrometheusSettings: PrometheusSettings | null;
  parsedDatadogSettings: { site: string; collectApm?: boolean; collectLogs?: boolean } | null;
  parsedGrafanaSettings: GrafanaSettings | null;
}

export interface ProviderSaveResult {
  settings: Record<string, unknown>;
  credentialToSave?: string;
  eventCredentialToSave?: string;
  revokeEventCredential?: boolean;
}

export type ProviderSaveOutcome = ProviderSaveResult | string;

export type ProviderSaveHandler = (
  input: SavePersistenceInput,
  current: CurrentConnector | undefined,
  initial: ProviderSaveResult,
) => Promise<ProviderSaveOutcome>;
