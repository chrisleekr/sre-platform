import { recordSignalDisposition, type Db } from '@sre/db';
import { alertText, service, severity, type NormalizedAlert } from './normalize';

/** Persists one scrubbed direct-provider lifecycle observation for inbox analytics. */
export function recordAlertmanagerDisposition(input: {
  db: Db;
  tenantId: string;
  connectorId: string;
  incidentId: string;
  channel: string;
  threadId: string;
  eventKey: string;
  signalKey: string;
  observedAt: Date;
  alert: NormalizedAlert;
}) {
  const disposition = input.alert.status === 'firing' ? 'investigate' : 'log';
  return recordSignalDisposition(input.db, input.tenantId, {
    source: input.alert.provider ?? 'alertmanager',
    sourceEventKey: input.eventKey,
    sourceEventAt: input.observedAt,
    signalKey: input.signalKey,
    dataSourceId: input.connectorId,
    surface: 'slack',
    channel: input.channel,
    threadId: input.threadId,
    summary: alertText(input.alert),
    reason: 'Connector-verified provider lifecycle observation.',
    service: service(input.alert.labels),
    severity: severity(input.alert.labels),
    disposition,
    effectiveDisposition: disposition,
    classificationMode: 'shadow',
    incidentId: input.incidentId,
    ticket: null,
  });
}
