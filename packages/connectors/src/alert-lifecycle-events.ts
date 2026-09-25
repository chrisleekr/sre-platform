import type {
  AlertLifecycle,
  AlertLifecycleObservation,
  AlertLifecycleResult,
} from './alert-lifecycle';
import { obj, str } from './values';

function date(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function stringMap(value: unknown): Record<string, string> | null {
  const entries = Object.entries(obj(value));
  if (
    entries.length > 100 ||
    entries.some(
      ([key, item]) => !key || key.length > 128 || typeof item !== 'string' || item.length > 16_384,
    )
  )
    return null;
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Validates per-alert lifecycle fields; group status and rendered text have no mutation authority. */
export function structuredAlertEvents(provider: 'alertmanager' | 'grafana'): AlertLifecycle {
  return {
    normalizeEvent(payload): AlertLifecycleResult {
      const event = obj(payload);
      if (
        event.version !== (provider === 'grafana' ? '1' : '4') ||
        !Array.isArray(event.alerts) ||
        event.alerts.length === 0 ||
        event.alerts.length > 500 ||
        Number(event.truncatedAlerts ?? 0) !== 0
      )
        return { status: 'unverified', reason: 'unsupported_event_schema' };
      const observations: AlertLifecycleObservation[] = [];
      for (const value of event.alerts) {
        const alert = obj(value);
        const labels = stringMap(alert.labels);
        const annotations = stringMap(alert.annotations);
        const fingerprint = str(alert.fingerprint);
        const startsAt = date(alert.startsAt);
        const endsAt = alert.status === 'resolved' ? date(alert.endsAt) : null;
        if (
          !labels ||
          !annotations ||
          !fingerprint ||
          !/^[a-f0-9]{16}$/.test(fingerprint) ||
          !startsAt ||
          !labels.alertname ||
          (alert.status !== 'firing' && alert.status !== 'resolved') ||
          (alert.status === 'resolved' && (!endsAt || endsAt < startsAt))
        )
          return { status: 'unverified', reason: 'unsupported_alert_schema' };
        observations.push({
          provider,
          status: alert.status,
          fingerprint,
          monitorIdentity: fingerprint,
          startsAt,
          endsAt,
          alertName: labels.alertname,
          labels,
          annotations,
          generatorUrl: str(alert.generatorURL) ?? null,
        });
      }
      return { status: 'verified', observations };
    },
  };
}
