import type { Incident, IncidentSignal } from './types';

/**
 * Returns the best available human-readable incident title.
 *
 * @param incident - Incident identity returned by the API.
 * @param signals - Normalized provider signals attached to the incident.
 */
export function incidentDisplayTitle(
  incident: Pick<Incident, 'title' | 'service'>,
  signals: ReadonlyArray<Pick<IncidentSignal, 'alertName'>> = [],
): string {
  const title = incident.title?.trim();
  if (title) return title;

  for (const signal of signals) {
    const alertName = signal.alertName?.trim();
    if (alertName) return alertName;
  }

  return incident.service;
}
