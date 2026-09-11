import type { CredentialGetter } from './request-credentials';
import { authenticatedFetch } from './authenticatedFetch';
import { checkResponse } from './request-error';

export type InvestigationSubject =
  | { kind: 'infrastructure_resource'; dataSourceId: string; entityId: string }
  | { kind: 'deployment'; deploymentId: string }
  | { kind: 'connector_verification'; connectorId: string }
  | { kind: 'topology_service'; service: string };

export interface InvestigationDeclaration {
  outcome: 'created' | 'existing';
  incidentId: string;
}

export interface ManualIncidentDraft {
  requestId: string;
  title: string;
  description: string;
  service: string;
  severity: 'sev1' | 'sev2' | 'sev3';
}

export async function createManualIncident(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  draft: ManualIncidentDraft,
): Promise<InvestigationDeclaration> {
  const response = await authenticatedFetch(`${apiBaseUrl}/incidents`, getCredentials, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  await checkResponse(response, 'Could not create the incident. Refresh and retry.');
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    outcome?: 'created' | 'existing';
    incidentId?: string;
  };
  if (!body.outcome || !body.incidentId)
    throw new Error('Could not confirm incident creation. Refresh before retrying.');
  return { outcome: body.outcome, incidentId: body.incidentId };
}

export async function declareInvestigation(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  subject: InvestigationSubject,
): Promise<InvestigationDeclaration> {
  const response = await authenticatedFetch(
    `${apiBaseUrl}/incidents/from-observation`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject }),
    },
  );
  await checkResponse(response, 'Could not start the investigation. Refresh and retry.');
  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    outcome?: 'created' | 'existing';
    incidentId?: string;
  };
  if (!body.outcome || !body.incidentId)
    throw new Error('Could not confirm the investigation. Refresh before retrying.');
  return { outcome: body.outcome, incidentId: body.incidentId };
}

export function investigationSubjectKey(subject: InvestigationSubject): string {
  switch (subject.kind) {
    case 'infrastructure_resource':
      return `${subject.kind}:${subject.dataSourceId}:${subject.entityId}`;
    case 'deployment':
      return `${subject.kind}:${subject.deploymentId}`;
    case 'connector_verification':
      return `${subject.kind}:${subject.connectorId}`;
    case 'topology_service':
      return `${subject.kind}:${subject.service}`;
  }
}

export async function listActiveInvestigations(
  apiBaseUrl: string,
  getCredentials: CredentialGetter,
  subjects: InvestigationSubject[],
): Promise<Map<string, string>> {
  if (subjects.length === 0) return new Map();
  const response = await authenticatedFetch(
    `${apiBaseUrl}/incidents/observation-workspaces`,
    getCredentials,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subjects }),
    },
  );
  if (!response.ok) return new Map();
  const body = (await response.json()) as {
    active?: Array<{ kind: string; sourceId: string; subjectId: string; incidentId: string }>;
  };
  return new Map(
    (body.active ?? []).map((item) => {
      const key =
        item.kind === 'infrastructure_resource'
          ? `${item.kind}:${item.sourceId}:${item.subjectId}`
          : `${item.kind}:${item.subjectId}`;
      return [key, item.incidentId];
    }),
  );
}
