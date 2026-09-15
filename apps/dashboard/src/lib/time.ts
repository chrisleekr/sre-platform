/** Compact relative time like "just now" / "5m ago" / "2h ago" / "3d ago". Shared by the deploy list
 * and the topology node drawer so the two views can never drift. */
export function relativeTime(iso: string, now: number): string {
  const mins = Math.floor((now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Compact time until a scheduled action, rounded up so future work is never presented as due now. */
export function futureRelativeTime(iso: string, now: number): string {
  const mins = Math.ceil((Date.parse(iso) - now) / 60_000);
  if (mins <= 0) return 'due now';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.ceil(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.ceil(hrs / 24)}d`;
}

/** Operator-readable local time with seconds so adjacent provider events remain distinguishable. */
export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso);
  if (!iso || Number.isNaN(date.getTime())) return 'Time unavailable';
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  }).format(date);
}
