import { STATUSCAKE_MAX_LISTED_TESTS } from '@sre/connectors';

const ID_RE = /^[A-Za-z0-9_-]+$/;

function testIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > STATUSCAKE_MAX_LISTED_TESTS ||
    value.some((id) => typeof id !== 'string' || !ID_RE.test(id)) ||
    new Set(value).size !== value.length
  )
    return null;
  return value as string[];
}

/** The public HTTPS origin StatusCake calls, or null when the value is not a bare HTTPS origin. */
function receiverOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value.replace(/\/$/, '') ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Validates the uptime notification binding of a StatusCake save. Fields the request omits keep
 * their saved values.
 * @param raw - Settings submitted with this save.
 * @param old - Settings currently stored.
 * @param eventTransport - Resolved delivery transport for this save.
 */
export function statusCakeBindingSettings(
  raw: Record<string, unknown>,
  old: Record<string, unknown>,
  eventTransport: unknown,
): Record<string, unknown> | string {
  const pick = (key: string) => (raw[key] !== undefined ? raw[key] : old[key]);
  const selected = testIds(pick('uptimeMonitorIds'));
  const excluded = testIds(pick('excludedMonitorIds'));
  if (!selected || !excluded)
    return `uptime test lists must be at most ${STATUSCAKE_MAX_LISTED_TESTS} distinct StatusCake test IDs`;
  // Rows saved before setup modes existed listed their tests explicitly.
  const setupMode = pick('setupMode') ?? (selected.length > 0 ? 'custom' : 'auto');
  if (setupMode !== 'auto' && setupMode !== 'custom') return 'invalid StatusCake setup mode';
  const origin = pick('receiverOrigin');
  const validOrigin = origin === undefined ? undefined : receiverOrigin(origin);
  // A connection configured by hand before managed setup keeps working, and can still change its
  // token or name, until the operator changes how it delivers.
  const changesDelivery = [
    'eventTransport',
    'setupMode',
    'uptimeMonitorIds',
    'excludedMonitorIds',
    'receiverOrigin',
  ].some((key) => raw[key] !== undefined);
  if (eventTransport === 'direct' && (changesDelivery || old.receiverOrigin !== undefined)) {
    if (!validOrigin)
      return 'StatusCake can only deliver to a public HTTPS API address. Ask your platform administrator to configure one.';
    if (setupMode === 'custom' && selected.length === 0)
      return 'choose at least one uptime test, or send notifications for all tests';
  }
  return {
    setupMode,
    uptimeMonitorIds: selected,
    excludedMonitorIds: excluded,
    ...(validOrigin ? { receiverOrigin: validOrigin } : {}),
  };
}
