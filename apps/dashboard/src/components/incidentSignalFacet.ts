import type { Incident } from '../lib/types';
import type { SignalFacet } from './SignalSpine';

type SignalIncident = Pick<Incident, 'activeSignalCount' | 'alertSource' | 'signalCount'>;

export function incidentSignalFacet(incident: SignalIncident): SignalFacet {
  if (incident.signalCount === undefined) {
    return { label: 'Signal state unknown', tone: 'unknown' };
  }
  if (incident.signalCount === 0) {
    return incident.alertSource === 'manual'
      ? { label: 'Provider signals not applicable', tone: 'unknown' }
      : { label: 'Signal tracking unavailable', tone: 'critical' };
  }

  const active = incident.activeSignalCount ?? incident.signalCount;
  return active > 0
    ? { label: `${active} active provider signals`, tone: 'critical' }
    : { label: 'Provider signals clear', tone: 'success' };
}
