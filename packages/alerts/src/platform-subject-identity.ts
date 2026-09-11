import type { InvestigationSubjectIdentity } from '@sre/db';
import { createHash } from 'node:crypto';

const digest = (parts: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Validates one exact platform subject identity component without normalization.
 *
 * @param value - Tenant-owned source or subject identifier.
 */
export function isPlatformSubjectIdentityPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 500 &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  );
}

/**
 * Produces a fixed-length fingerprint for an exact platform observation.
 *
 * @param identity - Typed provider identity to fingerprint.
 */
export function platformSubjectFingerprint(identity: InvestigationSubjectIdentity): string {
  return `platform:${identity.kind}:${digest([
    identity.kind,
    identity.sourceId,
    identity.subjectId,
  ])}`;
}

/**
 * Produces the signal identity shared by initial and deferred subject observations.
 *
 * @param subjectFingerprint - Stable fingerprint of the observed platform subject.
 * @param incidentId - Incident that owns the subject observation.
 */
export function platformSubjectSignalExternalId(
  subjectFingerprint: string,
  incidentId: string,
): string {
  return `platform:subject-signal:${digest([subjectFingerprint, incidentId])}`;
}
