/** A granular record at an object path, or an empty record when absent. */
export function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Coerce an id-like provider value to a string. */
export function idStr(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}
