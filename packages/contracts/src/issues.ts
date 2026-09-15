/** External issue changes are drafts until the requesting member confirms them. */
export interface IssueChanges {
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  state?: 'open' | 'closed';
}

export interface RepositoryIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
  state: 'open' | 'closed';
  updatedAt: string;
  url: string;
}

export interface IssueManagementSettings {
  enabled: boolean;
  repositories: string[];
}

export interface IssueDraftRequest {
  connectorId: string;
  repository: string;
  number?: number;
  changes: IssueChanges;
}

export interface IssueActionView extends IssueDraftRequest {
  destination: { connectionName: string; provider: string; repositoryUrl: string };
  id: string;
  requestedBy: string;
  status: 'draft' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
  expiresAt: string;
  before: RepositoryIssue | null;
  result: RepositoryIssue | null;
  error: string | null;
  canConfirm?: boolean;
}
