import type { Incident, IncidentSignal } from './types';
import { meaningfulIncidentTitle } from '@sre/contracts';

/**
 * Returns the best available human-readable incident title.
 *
 * @param incident - Incident identity returned by the API.
 * @param signals - Normalized provider signals attached to the incident.
 */
export function incidentDisplayTitle(
  incident: Pick<Incident, 'title' | 'service' | 'displayTitle' | 'titleSource'>,
  signals: ReadonlyArray<Pick<IncidentSignal, 'alertName'>> = [],
): string {
  if (incident.displayTitle) return incident.displayTitle;
  const title = meaningfulIncidentTitle(incident.title);
  if (title) return title;

  for (const signal of signals) {
    const alertName = signal.alertName?.trim();
    if (alertName) return alertName;
  }

  return 'Opening context unavailable';
}
