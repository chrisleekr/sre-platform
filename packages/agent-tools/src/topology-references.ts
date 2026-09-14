const names = {
  key: 'identityRef',
  subjectKey: 'subjectRef',
  topologySubjectKey: 'topologySubjectRef',
  candidateSubjectKeys: 'candidateSubjectRefs',
  resourceKey: 'resourceRef',
  resourceKeys: 'resourceRefs',
  repositoryKey: 'repositoryRef',
  evidenceKeys: 'evidenceRefs',
} as const;
type ReferenceName<K> = K extends keyof typeof names ? (typeof names)[K] : K;
const opaqueMaps = new Set(['scope', 'attributes', 'currentScope', 'requiredScope']);
export type TopologyToolEvidence<T> =
  T extends Array<infer Item>
    ? TopologyToolEvidence<Item>[]
    : T extends object
      ? { [K in keyof T as ReferenceName<K>]: TopologyToolEvidence<T[K]> }
      : T;

/** Expose topology correlations without weakening the credential-key redactor.
 * @param value - Trusted typed topology projection, never a raw provider payload.
 */
export function topologyReferences<T>(value: T): TopologyToolEvidence<T> {
  if (Array.isArray(value)) return value.map(topologyReferences) as TopologyToolEvidence<T>;
  if (value === null || typeof value !== 'object') return value as TopologyToolEvidence<T>;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      Object.hasOwn(names, key) ? names[key as keyof typeof names] : key,
      opaqueMaps.has(key) ? child : topologyReferences(child),
    ]),
  ) as TopologyToolEvidence<T>;
}
