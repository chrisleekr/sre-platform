const UNIT_MS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
} as const;

/** Resolve connector date math, an epoch, or an ISO-like timestamp to epoch milliseconds. */
export function resolveTimeMs(expression: string, nowMs: number, connector: string): number {
  const value = expression.trim();
  if (value === 'now') return nowMs;
  const relative = /^now\s*-\s*(\d+)\s*([smhdw])$/.exec(value);
  if (relative) {
    const unit = relative[2] as keyof typeof UNIT_MS;
    return nowMs - Number(relative[1]) * UNIT_MS[unit];
  }
  if (/^\d+$/.test(value)) {
    const epoch = Number(value);
    return epoch < 1e12 ? epoch * 1_000 : epoch;
  }
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`${connector} connector: unparseable time '${expression}'`);
}
