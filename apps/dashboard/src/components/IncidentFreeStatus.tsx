import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { IncidentFreeStatus } from '../lib/incidentFreeStatus';
import { incidentPath } from '../lib/routes';
import { SkeletonBlock } from './LoadingSkeleton';

const SECOND_MS = 1_000;
const DAY_SECONDS = 86_400;

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / SECOND_MS));
  const days = Math.floor(totalSeconds / DAY_SECONDS);
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function elapsedLabel(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / SECOND_MS));
  const days = Math.floor(totalSeconds / DAY_SECONDS);
  const hours = Math.floor((totalSeconds % DAY_SECONDS) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const units = [
    [days, 'day'],
    [hours, 'hour'],
    [minutes, 'minute'],
    [seconds, 'second'],
  ] as const;
  const parts = units
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : '0 seconds';
}

function IncidentFreeTimer({ asOf, startedAt }: { asOf: string; startedAt: string }) {
  const serverOffset = useMemo(() => Date.parse(asOf) - Date.now(), [asOf]);
  const startedAtMs = useMemo(() => Date.parse(startedAt), [startedAt]);
  const readElapsed = useCallback(
    () => Math.max(0, Date.now() + serverOffset - startedAtMs),
    [serverOffset, startedAtMs],
  );
  const [elapsed, setElapsed] = useState(readElapsed);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (interval !== undefined) clearInterval(interval);
      interval = undefined;
    };
    const start = () => {
      stop();
      if (document.visibilityState === 'visible') {
        interval = setInterval(() => setElapsed(readElapsed()), SECOND_MS);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setElapsed(readElapsed());
      start();
    };

    setElapsed(readElapsed());
    start();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [readElapsed]);

  return (
    <span
      role="timer"
      aria-label={`No SEV1/SEV2 incidents for ${elapsedLabel(elapsed)}`}
      className="whitespace-nowrap font-mono text-xl font-semibold tabular-nums text-success"
    >
      {formatElapsed(elapsed)}
    </span>
  );
}

function statusContent(status: IncidentFreeStatus) {
  if (status.state === 'running') {
    return (
      <>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-success">No SEV1/SEV2 incidents for</p>
          <p className="mt-1 text-xs text-ink-muted">
            Since{' '}
            <time dateTime={status.startedAt}>{new Date(status.startedAt).toLocaleString()}</time>
          </p>
          {status.lastIncident && (
            <p className="mt-1 truncate text-xs text-ink-muted">
              Last incident:{' '}
              <Link
                to={incidentPath(status.lastIncident.id)}
                className="font-semibold text-accent hover:text-info"
              >
                {status.lastIncident.title ?? status.lastIncident.id}
              </Link>
            </p>
          )}
        </div>
        <IncidentFreeTimer asOf={status.asOf} startedAt={status.startedAt} />
      </>
    );
  }
  if (status.state === 'paused') {
    return (
      <div className="min-w-0">
        <p className="text-sm font-semibold text-critical">Incident-free streak paused</p>
        <p className="mt-1 text-xs text-ink-muted">
          {status.qualifyingActiveCount} active SEV1/SEV2 incident
          {status.qualifyingActiveCount === 1 ? '' : 's'}
        </p>
      </div>
    );
  }
  if (status.state === 'never_observed') {
    return (
      <p className="text-sm font-semibold text-ink">
        No SEV1/SEV2 incident has been recorded since measurement began.
      </p>
    );
  }
  return <p className="text-sm font-semibold text-ink">Incident-free time unavailable.</p>;
}

export function IncidentFreeStatusRail({
  status,
  loading,
}: {
  status: IncidentFreeStatus;
  loading: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Incident-free status"
      className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b border-line bg-surface-subtle px-4 py-3"
    >
      <div className="min-w-0">
        <p className="font-instrument text-[0.68rem] font-semibold uppercase tracking-[0.1em] text-ink-faint">
          Incident-free streak
        </p>
        <p className="mt-1 text-xs text-ink-muted">Covers SEV1 and SEV2 incidents.</p>
      </div>
      {loading ? <SkeletonBlock className="h-7 w-36" /> : statusContent(status)}
    </div>
  );
}
