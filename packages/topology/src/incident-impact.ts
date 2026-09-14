import type { Db } from '@sre/db';
import type { BlastRadius } from '@sre/contracts';
import { resolveIncidentTopologyContext } from './incident-context';
import { computeBlastRadius } from './blast-radius';

/** Use the incident's scoped resolution instead of treating its conversation source as a service.
 * @param db - Tenant-scoped database.
 * @param tenantId - Workspace owning the incident.
 * @param incidentId - Incident whose affected candidates should select the impact origin.
 * @param fallbackService - Historical service identifier when structured evidence is absent.
 */
export async function computeIncidentBlastRadius(
  db: Db,
  tenantId: string,
  incidentId: string,
  fallbackService: string,
): Promise<BlastRadius> {
  const context = await resolveIncidentTopologyContext(db, tenantId, incidentId);
  if (!context) return computeBlastRadius(db, tenantId, fallbackService);
  const resolutions = context.topology.resolutions;
  const keys = [
    ...new Set(
      resolutions.flatMap((resolution) =>
        resolution.subjectKey ? [resolution.subjectKey] : resolution.candidateSubjectKeys,
      ),
    ),
  ];
  if (keys.length === 1 && resolutions.every((resolution) => resolution.status === 'resolved')) {
    const subject = context.topology.subjects.find((item) => item.key === keys[0])!;
    if (subject.kind !== 'service')
      return {
        service: fallbackService,
        mapped: false,
        dependents: { direct: [], indirect: [], insulated: [] },
        suspects: [],
        truncated: false,
        candidates: [{ key: subject.key, name: subject.name, scope: subject.scope }],
        note: 'The affected resource is identified, but no single logical service is proven for it. Resource and source evidence remain available; service-call impact is not inferred from ownership alone.',
      };
    return computeBlastRadius(db, tenantId, subject.name, {
      subjectKey: subject.key,
      environment: subject.scope.environment,
    });
  }
  if (
    resolutions.some(
      (resolution) => resolution.status === 'ambiguous' || resolution.status === 'needs_evidence',
    ) ||
    keys.length > 0
  ) {
    return {
      service: fallbackService,
      mapped: false,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
      candidates: context.topology.subjects
        .filter((subject) => keys.includes(subject.key))
        .map(({ key, name, scope }) => ({ key, name, scope })),
      note: 'The incident does not have one confirmed scoped service identity. Inspect its topology matches and choose the affected scope before calculating impact.',
    };
  }
  const mappings = [...new Set(context.mappings.map((mapping) => mapping.serviceName))];
  if (mappings.length === 1) {
    const assigned = context.mappings.some((mapping) =>
      mapping.candidateKey.startsWith('incident-service:'),
    );
    const candidates = context.observations
      .flatMap((observation) => observation.candidates)
      .filter((candidate) =>
        context.mappings.some((mapping) => mapping.candidateKey === candidate.key),
      );
    const scopes = [
      ...new Map(
        candidates.map((candidate) => [
          JSON.stringify(Object.entries(candidate.scope).sort(([a], [b]) => a.localeCompare(b))),
          candidate.scope,
        ]),
      ).values(),
    ];
    if (assigned || scopes.length <= 1) {
      const scope = assigned ? {} : scopes[0];
      return computeBlastRadius(db, tenantId, mappings[0]!, {
        scope,
        environment: scope?.environment,
      });
    }
  }
  if (resolutions.length || mappings.length > 1)
    return {
      service: fallbackService,
      mapped: false,
      dependents: { direct: [], indirect: [], insulated: [] },
      suspects: [],
      truncated: false,
      note: 'Affected service identity is unresolved. No conversation identifier or inferred candidate was used as a service.',
    };
  return computeBlastRadius(db, tenantId, fallbackService);
}
