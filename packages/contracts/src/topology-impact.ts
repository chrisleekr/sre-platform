/** One affected caller in the blast radius. `via` explains a non-direct tier. */
export interface BlastRadiusDependent {
  name: string;
  criticality: string | null;
  team: string | null;
  /** Minimum hop distance along the reported exposure tier. */
  hops: number;
  via?: 'async' | 'circuit_breaker';
  subjectKey?: string;
  scope?: Record<string, string>;
  evidenceKeys?: string[];
}

/** A direct (1-hop) downstream dependency of the failing service: a candidate root cause. */
export interface BlastRadiusSuspect {
  name: string;
  syncType: string;
  criticality: string | null;
  subjectKey?: string;
  scope?: Record<string, string>;
  evidenceKeys?: string[];
}

export interface BlastRadius {
  service: string;
  subjectKey?: string;
  scope?: Record<string, string>;
  candidates?: Array<{ key: string; name: string; scope: Record<string, string> }>;
  /** False when neither discovery nor the catalog provides an unambiguous service identity. */
  mapped: boolean;
  dependents: {
    direct: BlastRadiusDependent[];
    indirect: BlastRadiusDependent[];
    /** Legacy wire name: exposure through a declared breaker, not proven protection. */
    insulated: BlastRadiusDependent[];
    /** Observed calls without evidence of sync/async semantics or protection. */
    unclassified?: BlastRadiusDependent[];
  };
  suspects: BlastRadiusSuspect[];
  /** True when the direct-failure walk hit the depth cap; the radius may be larger. */
  truncated: boolean;
  note?: string;
}
