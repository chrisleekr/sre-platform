import { createHash } from 'node:crypto';
import type {
  AlertLifecycle,
  AlertLifecycleObservation,
  AlertLifecycleSubjectMatch,
} from '../../alert-lifecycle';
import { obj, str } from '../../values';

type Read = (path: string, query?: Record<string, string | number>) => Promise<unknown>;

const parsedDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
};

const UPTIME_SUBJECT = 'statuscake:uptime:';
const MONITOR_ID = /^[A-Za-z0-9_-]+$/;

// The stock Slack notice names only the checked URL. Both sides take WHATWG URL serialisation
// (lowercase scheme and host, default port dropped, empty path becomes "/") and must then be equal
// strings. Nothing else is rewritten, so scheme, port, path, query and trailing slash still differ.
const normalizedUrl = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};

/** Exact test and bounded period evidence. Absence of a period never proves recovery. */
export function statusCakeLifecycle(read: Read): AlertLifecycle {
  async function alertTrigger(
    path: string,
    observedAt: number,
    period?: { start: number },
  ): Promise<Date | null> {
    let before: number | undefined;
    let start: Date | null = null;
    let previous = Infinity;
    for (let page = 0; page < 5; page += 1) {
      const response = obj(
        await read(`${path}/alerts`, { limit: 100, ...(before === undefined ? {} : { before }) }),
      );
      if (
        !Array.isArray(response.data) ||
        !response.links ||
        typeof response.links !== 'object' ||
        Array.isArray(response.links)
      )
        return null;
      for (const value of response.data) {
        const alert = obj(value);
        const at = parsedDate(alert.triggered_at);
        if (
          !at ||
          at.getTime() > previous ||
          at.getTime() > Date.now() ||
          (alert.status !== 'up' && alert.status !== 'down')
        )
          return null;
        previous = at.getTime();
        if (period && at.getTime() > observedAt) continue;
        if (period && at.getTime() < period.start) return start;
        if (alert.status === 'up') return at.getTime() > observedAt ? null : start;
        if (at.getTime() <= observedAt) start = at;
      }
      const next = str(obj(response.links).next);
      if (!next) return start;
      const url = new URL(next);
      const cursor = Number(url.searchParams.get('before'));
      if (
        url.origin !== 'https://api.statuscake.com' ||
        url.pathname !== `${path}/alerts` ||
        !url.searchParams.has('before') ||
        !Number.isSafeInteger(cursor) ||
        cursor < 0 ||
        (before !== undefined && cursor >= before)
      )
        return null;
      before = cursor;
    }
    return null;
  }
  return {
    // Selects which test to ask about; readEpisode against that test is what authorises.
    async monitorForSubject(groupKey): Promise<AlertLifecycleSubjectMatch> {
      const wanted = groupKey.startsWith(UPTIME_SUBJECT)
        ? normalizedUrl(groupKey.slice(UPTIME_SUBJECT.length))
        : null;
      if (!wanted) return { status: 'unmatched', reason: 'unsupported_subject' };
      const unavailable = { status: 'unmatched', reason: 'inventory_unavailable' } as const;
      const matches = new Set<string>();
      try {
        // Uniqueness needs the whole inventory, so a listing past the page bound proves nothing.
        for (let page = 1; page <= 5; page += 1) {
          const response = obj(await read('/v1/uptime', { page, limit: 100 }));
          if (!Array.isArray(response.data)) return unavailable;
          for (const value of response.data) {
            const test = obj(value);
            if (normalizedUrl(test.website_url) !== wanted) continue;
            const id = str(test.id) ?? (typeof test.id === 'number' ? String(test.id) : undefined);
            if (!id || !MONITOR_ID.test(id)) return unavailable;
            matches.add(id);
          }
          const pages = obj(response.metadata).page_count;
          if (!Number.isSafeInteger(pages)) return unavailable;
          if (page < Number(pages)) continue;
          const [only] = matches;
          if (matches.size === 1 && only)
            return { status: 'matched', monitorId: only, family: 'uptime' };
          return {
            status: 'unmatched',
            reason: matches.size ? 'ambiguous_monitor' : 'no_matching_monitor',
          };
        }
        return unavailable;
      } catch {
        return unavailable;
      }
    },
    async readEpisode(query) {
      if (query.family !== 'uptime')
        return { status: 'unverified', reason: 'unsupported_check_family' };
      if (!MONITOR_ID.test(query.monitorId))
        return { status: 'unverified', reason: 'invalid_monitor_id' };
      const path = `/v1/uptime/${encodeURIComponent(query.monitorId)}`;
      try {
        const test = obj(obj(await read(path)).data);
        if (String(test.id) !== query.monitorId)
          return { status: 'unverified', reason: 'monitor_identity_mismatch' };
        if (test.paused === true || (test.status !== 'up' && test.status !== 'down'))
          return { status: 'unverified', reason: 'monitor_state_unavailable' };
        const observed = query.observedAt.getTime();
        const wanted = query.startsAt?.getTime();
        if (!Number.isFinite(observed) || (wanted !== undefined && !Number.isFinite(wanted)))
          return { status: 'unverified', reason: 'invalid_episode_time' };
        let before: number | undefined;
        let exhausted = false;
        const periods: Array<{ startsAt: Date; endsAt: Date | null; periodStartedAt?: Date }> = [];
        for (let page = 0; page < 5; page += 1) {
          const response = obj(
            await read(`${path}/periods`, {
              limit: 100,
              ...(before === undefined ? {} : { before }),
            }),
          );
          if (
            !Array.isArray(response.data) ||
            !response.links ||
            typeof response.links !== 'object' ||
            Array.isArray(response.links)
          )
            return { status: 'unverified', reason: 'unsupported_period_schema' };
          for (const value of response.data) {
            const period = obj(value);
            if (period.status !== 'down') continue;
            const startsAt = parsedDate(period.created_at);
            const endsAt = parsedDate(period.ended_at);
            if (!startsAt || !endsAt || (endsAt && endsAt < startsAt))
              return { status: 'unverified', reason: 'unsupported_period_schema' };
            const target = wanted ?? observed;
            if (startsAt.getTime() <= target && (!endsAt || endsAt.getTime() >= target))
              periods.push({
                startsAt: wanted === undefined ? startsAt : new Date(wanted),
                endsAt,
                periodStartedAt: startsAt,
              });
          }
          const next = str(obj(response.links).next);
          if (!next) break;
          const url = new URL(next);
          const cursor = Number(url.searchParams.get('before'));
          if (
            url.origin !== 'https://api.statuscake.com' ||
            url.pathname !== `${path}/periods` ||
            !url.searchParams.has('before') ||
            !Number.isSafeInteger(cursor) ||
            cursor < 0 ||
            (before !== undefined && cursor >= before)
          )
            return { status: 'unverified', reason: 'invalid_history_cursor' };
          if (periods.length > 0) break;
          before = cursor;
          if (page === 4) exhausted = true;
        }
        if (periods.length === 0 && test.status === 'down') {
          // Completed period history can omit the active outage. Alert history provides its real trigger.
          const trigger = await alertTrigger(path, observed);
          if (trigger && (wanted === undefined || wanted === trigger.getTime()))
            periods.push({ startsAt: trigger, endsAt: null });
        }
        // Current Up with no historical target is a completed wakeup, never recovery evidence.
        if (!periods.length && !exhausted && wanted === undefined && test.status === 'up')
          return { status: 'verified', observations: [] };
        if (periods.length !== 1)
          return {
            status: 'unverified',
            reason: periods.length
              ? 'ambiguous_episode'
              : exhausted
                ? 'history_window_exhausted'
                : 'episode_not_retained',
          };
        const period = periods[0]!;
        if (wanted === undefined && period.endsAt) {
          const trigger = await alertTrigger(path, observed, {
            start: period.startsAt.getTime(),
          });
          if (!trigger) return { status: 'unverified', reason: 'episode_not_retained' };
          period.startsAt = trigger;
        }
        if (!period.endsAt && test.status !== 'down')
          return { status: 'unverified', reason: 'conflicting_provider_evidence' };
        const identity = `uptime:${query.monitorId}`;
        const observation: AlertLifecycleObservation = {
          provider: 'statuscake',
          status: period.endsAt ? 'resolved' : 'firing',
          monitorIdentity: identity,
          fingerprint: createHash('sha256').update(identity).digest('hex'),
          startsAt: period.startsAt,
          endsAt: period.endsAt,
          alertName: str(test.name) ?? identity,
          labels: { monitor_id: query.monitorId, check_type: 'uptime' },
          annotations: period.periodStartedAt
            ? { provider_period_started_at: period.periodStartedAt.toISOString() }
            : {},
          generatorUrl: null,
        };
        return { status: 'verified', observations: [observation] };
      } catch {
        return { status: 'unverified', reason: 'provider_read_failed' };
      }
    },
  };
}
