export {
  IncidentCorrectionConflictError,
  getActiveMergedTargetTx,
  lockCausalGraphTx,
  lockIncidentWorkTx,
  recordAgentCohortRelationTx,
  recordIncidentRelationTx,
  type IncidentCorrectionInput,
  type IncidentRelationInput,
} from './incident-relation-repo/core';
export * from './incident-relation-repo/causal';
export { mergeIncidents } from './incident-relation-repo/merge';
export * from './incident-relation-repo/queries';
export { splitMergedIncident } from './incident-relation-repo/split';
