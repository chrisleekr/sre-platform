export const ENTITY_KINDS = [
  'service',
  'workload',
  'namespace',
  'node',
  'cluster',
  'repository',
  'deployment',
  'connector',
  'endpoint',
  'database',
  'host',
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export const ENTITY_CAPABILITIES = [
  'availability',
  'alert_context',
  'runtime',
  'metrics',
  'logs',
  'source_code',
  'deployments',
  'runbooks',
  'topology',
] as const;

export type EntityCapability = (typeof ENTITY_CAPABILITIES)[number];

/** The system that produced an observation. It is not assumed to be the affected entity. */
export interface SignalSource {
  kind: 'monitor' | 'platform_observer' | 'human_report' | 'connector';
  provider: string;
  dataSourceId: string | null;
  externalId: string;
  displayName: string;
  observedAt: string;
}

/** One provider-derived possibility for what an observation is about. */
export interface AffectedEntityCandidate {
  /** Stable provider-neutral identity used by tenant-local mapping corrections. */
  key: string;
  kind: EntityKind;
  stableId: string;
  displayName: string;
  scope: Record<string, string>;
  provenance: {
    kind:
      'provider_label' | 'platform_snapshot' | 'catalog' | 'human_input' | 'classifier_inference';
    source: string;
  };
  confidence: number;
  observedAt: string;
  completeness: 'complete' | 'partial';
  requiredCapabilities: EntityCapability[];
}

export type EntityMappingMethod = 'human' | 'catalog_exact';

/** Resolution from an observed entity to a tenant catalog service. */
export interface EntityMapping {
  candidateKey: string;
  candidateKind: EntityKind;
  serviceName: string;
  method: EntityMappingMethod;
  confirmedByUserId: string | null;
  rationale: string | null;
  updatedAt: string;
}

/** A concrete missing read that prevents the investigator from reducing uncertainty. */
export interface EntityCapabilityGap {
  entityKey: string;
  capability: EntityCapability;
  reason: 'connector_missing' | 'connector_unavailable' | 'scope_mismatch';
  summary: string;
  requiredScope: Record<string, string>;
  connectors: Array<{
    id: string;
    name: string;
    type: string;
    status: 'out_of_scope' | 'unavailable';
    currentScope: Readonly<Record<string, string>>;
  }>;
  action: { label: string; href: '/connectors' };
}

/**
 * Produces a deterministic identity without provider-specific matching rules.
 *
 * @param kind - Provider-neutral entity kind.
 * @param stableId - Source-stable entity identifier.
 * @param scope - Sorted identity scope such as cluster or namespace.
 */
export function entityCandidateKey(
  kind: EntityKind,
  stableId: string,
  scope: Record<string, string> = {},
): string {
  const normalizedScope = Object.fromEntries(
    Object.entries(scope)
      .filter(([, value]) => value.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify([kind, stableId, normalizedScope]);
}
