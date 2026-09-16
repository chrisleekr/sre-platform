import type {
  ConnectorRegistry,
  GitHubInstallationSummary,
  GitHubManifestConversion,
  GitHubRepositorySummary,
  GitLabDiscovery,
  GitLabProjectSummary,
} from '@sre/connectors';
import type { Db, SecretStore } from '@sre/db';
import type { SnapshotCache } from '@sre/queue';
import type { AlertmanagerSmeeManager } from '../alertmanager-smee';
import type { AuthDeps } from '../auth';
import type { GitHubSmeeManager } from '../github-smee';
import type { GitLabSmeeManager } from '../gitlab-smee';
import type { Logger } from '../logger';

export interface ConnectorRoutesDeps {
  auth: AuthDeps;
  db: Db;
  secrets: SecretStore;
  /** Resolves the connector implementation to probe on test-connection. */
  registry: ConnectorRegistry;
  cache?: SnapshotCache;
  log?: Logger;
  githubSmee?: Pick<GitHubSmeeManager, 'replace' | 'stop'>;
  gitlabSmee?: Pick<GitLabSmeeManager, 'replace' | 'stop'>;
  alertmanagerSmee?: Pick<AlertmanagerSmeeManager, 'replace' | 'stop'>;
  discoverGitLabProjects?: (
    settings: Record<string, unknown>,
    credential: string,
  ) => Promise<GitLabProjectSummary[]>;
  discoverGitLabGroup?: (
    settings: Record<string, unknown>,
    credential: string,
  ) => Promise<GitLabDiscovery>;
  discoverGitHubInstallations?: (
    settings: Record<string, unknown>,
    credential: string,
  ) => Promise<GitHubInstallationSummary[]>;
  discoverGitHubRepositories?: (
    settings: Record<string, unknown>,
    credential: string,
  ) => Promise<GitHubRepositorySummary[]>;
  convertGitHubAppManifest?: (code: string) => Promise<GitHubManifestConversion>;
}

export interface GitLabSettings {
  issueManagement?: import('@sre/contracts').IssueManagementSettings;
  baseUrl: string;
  groupId?: string | number;
  groupPath?: string;
  groupName?: string;
  eventTransport?: 'direct' | 'smee' | 'none';
  hookScope?: 'projects' | 'group';
  eventStrategy?: 'group' | 'managed_projects' | 'system';
  /** Compatibility only; new connections are always group scoped. */
  projectId?: string | number;
  service?: string;
}

export interface GitHubSettings {
  issueManagement?: import('@sre/contracts').IssueManagementSettings;
  appId: string;
  installationId: string;
  accountLogin?: string;
  repositorySelection?: 'all' | 'selected';
  permissions?: Record<string, 'read' | 'write'>;
  appSlug?: string;
  eventTransport?: 'direct' | 'smee';
  /** Compatibility only; new installation-wide connections do not configure a default repo. */
  repo?: string;
  service?: string;
}

export interface ArgoCdProjectApplicationScope {
  name: string;
  namespace?: string;
}

export interface ArgoCdProjectBinding {
  project: string;
  applications: ArgoCdProjectApplicationScope[];
}

export interface ArgoCdSettings {
  baseUrl: string;
  accessRole?: string;
  applicationsInAnyNamespace: boolean;
  projects: ArgoCdProjectBinding[];
  labelSelector?: string;
  caCert?: string;
  insecureSkipTLSVerify?: boolean;
}

export const PROMETHEUS_AUTH_TYPES = ['none', 'bearer', 'basic', 'header', 'mtls'] as const;
export type PrometheusAuthType = (typeof PROMETHEUS_AUTH_TYPES)[number];

export interface PrometheusSettings {
  baseUrl: string;
  authType: PrometheusAuthType;
  caCert?: string;
  insecureSkipTLSVerify?: boolean;
  eventTransport: 'direct' | 'smee' | 'none';
  alertChannel?: string;
  cohortWindowSec?: number;
  episodeGroupingWindowSec: number;
  maxIncidentAgeSec: number;
}
