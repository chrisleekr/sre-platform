import type { DirectoryAccountFilter } from '@sre/db';

const FILTER = /^(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i;

/** Parses the deliberately bounded filter subset advertised by this SCIM service. */
export function parseScimFilter(value: string | undefined): DirectoryAccountFilter | null | false {
  if (value === undefined) return null;
  if (value.length > 2_048) return false;
  const match = value.trim().match(FILTER);
  if (!match) return false;
  let parsed: string;
  try {
    parsed = JSON.parse(`"${match[2]}"`) as string;
  } catch {
    return false;
  }
  if (!parsed || parsed.length > 2_048) return false;
  return {
    attribute: match[1]!.toLowerCase() === 'username' ? 'userName' : 'externalId',
    value: parsed,
  };
}
