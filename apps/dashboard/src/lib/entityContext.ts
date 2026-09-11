import type {
  AffectedEntityCandidate,
  EntityCapabilityGap,
  EntityMapping,
  SignalSource,
} from '@sre/contracts';

export interface IncidentEntityContext {
  observations: Array<{
    signalId: string;
    source: SignalSource | null;
    candidates: AffectedEntityCandidate[];
  }>;
  mappings: EntityMapping[];
  services: Array<{
    name: string;
    team: string | null;
    criticality: string | null;
    dependencies: Array<{
      direction: 'upstream' | 'downstream';
      service: string;
      protocol: string | null;
    }>;
    repositories: Array<{
      provider: string;
      fullName: string;
      path: string;
      confirmed: boolean;
    }>;
    deployments: Array<{
      source: string;
      repository: string;
      revision: string;
      status: string;
      url: string | null;
      deployedAt: string;
    }>;
    runbooks: Array<{ id: string; title: string | null; source: string; verified: boolean }>;
  }>;
  capabilityGaps: EntityCapabilityGap[];
}
