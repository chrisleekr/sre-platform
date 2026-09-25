import { createHash } from 'node:crypto';
import type {
  AlertLifecycle,
  AlertLifecycleObservation,
  AlertLifecycleResult,
} from '../../alert-lifecycle';
import { obj, str } from '../../values';

type Read = (path: string, query?: Record<string, string | number>) => Promise<unknown>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Exact monitor-group state, with provider timestamps fencing late recovery notifications. */
export function datadogLifecycle(read: Read): AlertLifecycle {
  async function observe(
    monitorId: string,
    scope: string,
    occurredAt: number,
    cycleKey?: string,
  ): Promise<AlertLifecycleResult> {
    if (
      !/^\d+$/.test(monitorId) ||
      !Number.isSafeInteger(occurredAt) ||
      occurredAt < 1_000_000_000_000
    )
      return { status: 'unverified', reason: 'invalid_monitor_or_event_time' };
    try {
      const monitor = obj(await read(`/api/v1/monitor/${monitorId}`, { group_states: 'all' }));
      if (String(monitor.id) !== monitorId)
        return { status: 'unverified', reason: 'monitor_identity_mismatch' };
      const group = obj(obj(obj(monitor.state).groups)[scope]);
      const triggered = Number(group.last_triggered_ts);
      const resolved = Number(group.last_resolved_ts);
      if (!Number.isSafeInteger(triggered) || triggered <= 0 || triggered * 1000 > occurredAt)
        return { status: 'unverified', reason: 'episode_order_unverified' };
      const status =
        group.status === 'OK' ? 'resolved' : group.status === 'Alert' ? 'firing' : null;
      if (
        !status ||
        (status === 'resolved' &&
          (!Number.isSafeInteger(resolved) || resolved < triggered || resolved * 1000 > Date.now()))
      )
        return { status: 'unverified', reason: 'group_state_unverified' };
      const identity = JSON.stringify([monitorId, scope]);
      const observation: AlertLifecycleObservation = {
        provider: 'datadog',
        status,
        monitorIdentity: identity,
        fingerprint: digest([monitorId, scope, cycleKey ?? triggered]),
        startsAt: new Date(triggered * 1000),
        endsAt: status === 'resolved' ? new Date(resolved * 1000) : null,
        alertName: str(monitor.name) ?? `Monitor ${monitorId}`,
        labels: {
          monitor_id: monitorId,
          alert_scope: scope,
        },
        annotations: {},
        generatorUrl: null,
      };
      return { status: 'verified', observations: [observation] };
    } catch {
      return { status: 'unverified', reason: 'provider_read_failed' };
    }
  }
  return {
    normalizeEvent(payload) {
      const event = obj(payload);
      const monitorId = str(event.alert_id);
      const cycleKey = str(event.alert_cycle_key);
      const occurredAt = Number(event.date);
      const transition = str(event.alert_transition);
      if (
        !monitorId ||
        !/^\d+$/.test(monitorId) ||
        !cycleKey ||
        cycleKey.length > 1024 ||
        typeof event.alert_scope !== 'string' ||
        event.alert_scope.length > 4096 ||
        !transition ||
        !Number.isSafeInteger(occurredAt) ||
        occurredAt < 1_000_000_000_000
      )
        return { status: 'unverified', reason: 'unsupported_event_schema' };
      // A repeat only re-drives a cycle a real trigger already retained, so Renotify from any
      // state is safe to pass on.
      const repeated = transition === 'Re-Triggered' || transition === 'Renotify';
      // Warn, No Data and their repeats never page. Datadog may add transitions; they are
      // acknowledged, not treated as malformed.
      if (!repeated && transition !== 'Triggered' && transition !== 'Recovered')
        return { status: 'ignored', reason: 'transition_not_handled' };
      const resolved = transition === 'Recovered';
      const identity = JSON.stringify([monitorId, event.alert_scope]);
      const episodeKey = `datadog:${digest([monitorId, event.alert_scope, cycleKey])}`;
      return {
        status: 'verified',
        observations: [
          {
            provider: 'datadog',
            status: resolved ? 'resolved' : 'firing',
            fingerprint: digest([monitorId, event.alert_scope, cycleKey]),
            monitorIdentity: identity,
            episodeKey,
            ...(repeated ? { repeatedTrigger: true } : {}),
            startsAt: resolved ? null : new Date(occurredAt),
            endsAt: resolved ? new Date(occurredAt) : null,
            alertName: str(event.alert_title) ?? `Monitor ${monitorId}`,
            labels: {
              monitor_id: monitorId,
              alert_scope: event.alert_scope,
              alert_cycle_key: cycleKey,
            },
            annotations: {},
            generatorUrl: null,
          },
        ],
      };
    },
    async readEpisode(query) {
      if (typeof query.scope !== 'string')
        return { status: 'unverified', reason: 'exact_group_required' };
      const result = await observe(
        query.monitorId,
        query.scope,
        query.observedAt.getTime(),
        query.cycleKey,
      );
      if (
        result.status === 'verified' &&
        query.startsAt &&
        result.observations[0]?.startsAt?.getTime() !== query.startsAt.getTime()
      )
        return { status: 'unverified', reason: 'episode_not_retained' };
      return result;
    },
  };
}
