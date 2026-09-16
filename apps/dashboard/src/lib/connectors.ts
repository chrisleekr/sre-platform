/**
 * A configured connector as projected by GET /connectors. `settings` is opaque JSON (per connector
 * type); the credential is never returned.
 */
export interface ConnectorSummary {
  id: string;
  name: string;
  type: string;
  settings: Record<string, unknown>;
  enabled: boolean;
  capabilities?: {
    availability: 'ready' | 'incomplete';
    configuration: 'tenant' | 'builtin';
    investigation: 'tools' | 'none';
    polling: 'snapshots' | 'none';
    events: 'authenticated' | 'none';
    instances: 'multiple' | 'singleton';
    topology?: 'inventory' | 'on_demand';
  };
  credentialConfigured?: boolean;
  verification?: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    failureCategory: string | null;
    durationMs?: number | null;
    rateLimit?: { remaining: number | null; resetAt: string | null };
  };
  polling?: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    snapshotCount: number;
    errorCount: number;
    failureCategory: string | null;
    baselineTruncated?: boolean;
    gitlabCoverage?: {
      total: number;
      notChecked: number;
      failed: number;
      backlog: number;
      trackingLimited?: number;
      oldestReadAt: string | null;
      latestReadAt: string | null;
      projects: Array<{
        project: string;
        lastAttemptAt: string | null;
        lastSuccessAt: string | null;
        failureCategory: string | null;
        backlog: boolean;
        trackingLimited?: boolean;
      }>;
    };
    projects?: Array<{
      project: string;
      status: string;
      failureCategory?: string;
    }>;
    durationMs?: number | null;
    rateLimit?: { remaining: number | null; resetAt: string | null };
  };
  repositoryCount?: number;
  webhookPath?: string;
  events?: {
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    count: number;
    failureCategory: string | null;
  };
}

export type PrometheusAuthType = 'none' | 'bearer' | 'basic' | 'header' | 'mtls';

export interface PrometheusSettings {
  baseUrl: string;
  authType: PrometheusAuthType;
  caCert?: string;
  caConfigured?: boolean;
  insecureSkipTLSVerify?: boolean;
  eventTransport?: 'direct' | 'smee' | 'none';
  alertChannel?: string;
  cohortWindowSec?: number;
  episodeGroupingWindowSec?: number;
  maxIncidentAgeSec?: number;
  eventCredentialConfigured?: boolean;
  smeeConfigured?: boolean;
  /** Write-only local relay source. The API never returns it. */
  smeeUrl?: string;
}

export interface ConnectorTestResult {
  status: 'healthy' | 'unhealthy' | 'not_applicable';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  relayStatus?: 'connected' | 'stopped' | 'failed';
  failureCategory?:
    'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable' | 'tls';
  enabled: boolean;
}

/**
 * The Kubernetes connector settings the connect wizard collects. `caCert`/`insecureSkipTLSVerify`
 * satisfy the API rule that a private `apiUrl` cannot use system trust. All fields are stored as
 * opaque connector settings by the API.
 */
export interface KubernetesSettings {
  accessId?: string;
  name?: string;
  apiUrl: string;
  namespace: string;
  caCert?: string;
  caConfigured?: boolean;
  insecureSkipTLSVerify?: boolean;
}

/** Result of POST /connectors/kubernetes/{dataSourceId}/test: the three-state `ProbeResult` every connector
 *  returns, plus `enabled` (the probe flips it server-side on a pass). Kubernetes-specific checks
 *  live under `checks`. */
export interface KubernetesTestResult {
  status: 'healthy' | 'unhealthy' | 'not_applicable';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  checks?: { canListPods: boolean; secretsDenied: boolean };
  enabled: boolean;
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
  /** Write-only input; list responses expose only smeeConfigured. */
  smeeUrl?: string;
  smeeConfigured?: boolean;
  webhookSigningTokenConfigured?: boolean;
  webhookSecretConfigured?: boolean;
  /** Compatibility for saved single-project connectors. */
  projectId?: string | number;
  service?: string;
}

export interface GitLabProjectSummary {
  id: number;
  name: string;
  pathWithNamespace: string;
  webUrl: string;
  defaultBranch?: string;
  visibility?: string;
  archived: boolean;
  lastActivityAt?: string;
}

export interface GitLabDiscovery {
  group: { id: number; name: string; fullPath: string; webUrl: string };
  projects: GitLabProjectSummary[];
  instance?: { version: string; enterprise: boolean };
}

export interface GitLabTestResult {
  status: 'healthy' | 'unhealthy';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  checks?: {
    canReadGroup?: boolean;
    canEnumerateProjects?: boolean;
    hasProjects?: boolean;
    canReadProject?: boolean;
    canReadCode?: boolean;
    canReadPipelines?: boolean;
    canReadDeployments?: boolean;
    webhookSecretConfigured?: boolean;
    webhookSigningTokenConfigured?: boolean;
  };
  details?: { group?: string; projectCount?: number; eventSync?: string };
  failureCategory?: 'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable';
  enabled: boolean;
}

export interface GitHubSettings {
  issueManagement?: import('@sre/contracts').IssueManagementSettings;
  appId: string;
  installationId?: string | number;
  accountLogin?: string;
  repositorySelection?: 'all' | 'selected';
  permissions?: Record<string, 'read' | 'write'>;
  appSlug?: string;
  eventTransport?: 'direct' | 'smee';
  /** Write-only setup input. The API stores the channel with the encrypted connector credential. */
  smeeUrl?: string;
  smeeConfigured?: boolean;
}

export interface GitHubInstallationSummary {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: 'all' | 'selected';
  permissions: Record<string, 'read' | 'write'>;
  writePermissions?: string[];
  appSlug?: string;
}

export interface GitHubRepositorySummary {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  defaultBranch?: string;
  private: boolean;
  archived: boolean;
  webUrl: string;
  pushedAt?: string;
}

export interface GitHubTestResult {
  status: 'healthy' | 'unhealthy';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  checks?: {
    canEnumerateRepositories?: boolean;
    hasRepositories?: boolean;
    canReadRepository?: boolean;
    canReadDeployments?: boolean;
    canReadContents?: boolean;
    canReadPullRequests?: boolean;
    canReadActions?: boolean;
    readOnlyApp?: boolean;
    allowedPermissions?: boolean;
    webhookSecretConfigured?: boolean;
  };
  details?: { repositoryCount?: number };
  failureCategory?: 'permission_denied' | 'rate_limited' | 'provider_unavailable' | 'unreachable';
  durationMs?: number;
  rateLimitRemaining?: number;
  rateLimitResetAt?: string;
  enabled: boolean;
}

export interface ArgoCdApplicationScope {
  name: string;
  namespace?: string;
}

export interface ArgoCdProjectBinding {
  project: string;
  applications: ArgoCdApplicationScope[];
  credentialConfigured?: boolean;
}

export interface ArgoCdSettings {
  baseUrl: string;
  accessRole?: string;
  applicationsInAnyNamespace: boolean;
  projects: ArgoCdProjectBinding[];
  labelSelector?: string;
  caCert?: string;
  caConfigured?: boolean;
  insecureSkipTLSVerify?: boolean;
}

export interface ArgoCdTestResult {
  status: 'healthy' | 'unhealthy';
  reachable: boolean;
  authorized: boolean;
  warnings: string[];
  checks?: {
    allProjectIdentitiesMatch?: boolean;
    allProjectReadsVerified?: boolean;
    allProjectDenySamplesPassed?: boolean;
    tlsTrusted?: boolean;
    tlsVerificationDisabled?: boolean;
    allProjectsReadable?: boolean;
    allProjectsHaveApplications?: boolean;
  };
  details?: {
    projects?: Array<{
      project: string;
      status: 'healthy' | 'unhealthy';
      reachable: boolean;
      authorized: boolean;
      warnings: string[];
      checks?: Record<string, boolean>;
      failureCategory?: string;
      durationMs?: number;
    }>;
  };
  failureCategory?: 'permission_denied' | 'provider_unavailable' | 'unreachable' | 'tls';
  durationMs?: number;
  enabled: boolean;
}

export interface ArgoCdAccessResult {
  instructions: {
    project: string;
    role: string;
    identity: string;
    policies: string[];
    tokenCommand: string;
  };
  commands: { createRole: string; addPolicies: string; install: string; uninstall: string };
}
