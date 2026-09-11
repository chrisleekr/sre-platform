import type { ArgoCdAccessResult } from '../../lib/connectors';

const LEGACY_ACCESS_ROLE = 'sre-platform';

export function newAccessRole(): string {
  return `${LEGACY_ACCESS_ROLE}-${crypto.randomUUID().slice(0, 8)}`;
}

export interface ApplicationDraft {
  name: string;
  namespace: string;
}

export interface ProjectDraft {
  project: string;
  applications: ApplicationDraft[];
  token: string;
  credentialConfigured: boolean;
  access: ArgoCdAccessResult | null;
}

export function host(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function newProject(project = 'default'): ProjectDraft {
  return {
    project,
    applications: [{ name: '*', namespace: '*' }],
    token: '',
    credentialConfigured: false,
    access: null,
  };
}

export { LEGACY_ACCESS_ROLE };
