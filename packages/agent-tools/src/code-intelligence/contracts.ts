import type {
  RepositoryRole,
  RuntimeArtifact,
  SourceCodeReader,
  SourceRepository,
} from '@sre/connectors';
import { getIncidentSummary, type Db, type DeploymentBoundary } from '@sre/db';
import * as z from 'zod';
import type { TopologySourceEvidence } from '@sre/contracts';

export const MAX_REPOSITORIES = 3;
export const MAX_PROVIDER_CALLS = 10;
export const MAX_RUNTIME_ARTIFACTS = 20;
export const MAX_SEARCH_QUERIES = 3;
export const MAX_PATH_CANDIDATES = 5;
export const EXCERPT_CONTEXT_LINES = 10;
export const MAX_EXCERPT_LINES = 120;
export const MAX_EXCERPT_CHARS = 16 * 1024;

export const investigateCodeInput = z
  .object({
    stackTrace: z
      .string()
      .max(32 * 1024)
      .optional(),
    errorText: z
      .string()
      .max(4 * 1024)
      .optional(),
    focus: z.string().max(512).optional(),
    evidenceIds: z.array(z.uuid()).max(10).optional(),
  })
  .refine(
    (input) => Boolean(input.stackTrace?.trim() || input.errorText?.trim() || input.focus?.trim()),
    'stackTrace, errorText, or focus is required',
  );

export type InvestigateCodeInput = z.infer<typeof investigateCodeInput>;
export type CodeEvidenceStrength =
  'verified' | 'corroborated' | 'declared' | 'candidate' | 'unresolved';

export interface CodeRevisionEvidence {
  repository: SourceRepository;
  revision: string | null;
  role: RepositoryRole;
  basis: 'runtime_annotation' | 'deployment_event' | 'default_head' | 'topology_declaration';
  strength: CodeEvidenceStrength;
  providerUrl: string | null;
  deployedAt: string | null;
  uncertainties: string[];
  topologyEvidenceRefs?: string[];
  topologyObservedAt?: string[];
}

export interface CodeLocationEvidence {
  repository: SourceRepository;
  revision: string;
  revisionBasis: CodeRevisionEvidence['basis'];
  strength: CodeEvidenceStrength;
  path: string;
  startLine: number;
  endLine: number;
  excerpt: string;
  excerptSha256: string;
  providerUrl: string;
  matchedBy: Array<'stack_path' | 'stack_symbol' | 'error_text' | 'focus'>;
  changedFromPreviousRevision: boolean | null;
  causality: 'possible' | 'unknown';
  sourceEvidenceIds: string[];
}

export interface InvestigateCodeResult {
  status:
    | 'located'
    | 'missing_mapping'
    | 'ambiguous'
    | 'missing_revision'
    | 'source_changed'
    | 'no_code_anchor'
    | 'no_match';
  artifacts: RuntimeArtifact[];
  revisions: CodeRevisionEvidence[];
  evidence: CodeLocationEvidence[];
  uncertainties: string[];
  requiredSetup: string[];
}

export interface StackAnchor {
  path: string;
  line: number | null;
  functionName: string | null;
}

export interface SearchAnchor {
  query: string;
  matchedBy: 'stack_symbol' | 'error_text' | 'focus';
}

export interface RepositoryTarget {
  reader: SourceCodeReader;
  repository: SourceRepository;
  topology?: TopologySourceEvidence['repositories'][number];
}

export interface ResolvedRevision {
  evidence: CodeRevisionEvidence;
  previousRevision: string | null;
}

export interface CodeContextReader {
  incident(tenantId: string, incidentId: string): ReturnType<typeof getIncidentSummary>;
  onset?(tenantId: string, incidentId: string): Promise<Date | null>;
  sources?(
    tenantId: string,
    incidentId: string,
    legacyService?: string,
  ): Promise<TopologySourceEvidence | null>;
  evidenceIds?(tenantId: string, incidentId: string, proposed: string[]): Promise<string[]>;
  deploymentBoundary(
    tenantId: string,
    service: string,
    repository: SourceRepository,
    at: Date,
  ): Promise<DeploymentBoundary>;
}

export type InvestigateCodeDeps =
  { db: Db; context?: never } | { context: CodeContextReader; db?: never };
