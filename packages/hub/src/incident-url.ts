/**
 * Builds a dashboard incident link when the dashboard origin is configured.
 *
 * @param base - Configured dashboard origin, if available.
 * @param incidentId - Incident identifier appended to the dashboard route.
 */
export function incidentUrl(base: string | undefined, incidentId: string): string | null {
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/w/incidents/${encodeURIComponent(incidentId)}`;
}

/**
 * Builds the dashboard postmortem link for an incident when the dashboard origin is configured.
 *
 * @param base - Configured dashboard origin, if available.
 * @param incidentId - Incident whose postmortem page is linked.
 */
export function postmortemUrl(base: string | undefined, incidentId: string): string | null {
  const incident = incidentUrl(base, incidentId);
  return incident ? `${incident}/postmortem` : null;
}
